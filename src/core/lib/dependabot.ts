import type { BotConfig, CheckRun, PullRequest, Status } from '../types.js'
import { hasLabel, isMergeReady } from './auto-approve.js'
import {
  failedRequiredContexts,
  missingRequiredContexts,
  pendingRequiredContexts,
} from './checks.js'
import { pathsAreWithin } from './glob.js'

const DEPENDABOT_LOGINS = new Set([
  'dependabot[bot]',
  'dependabot-preview[bot]',
])

export type DependabotSafetyDecision = {
  safe: boolean
  reasons: string[]
}

export type DependabotRecovery = {
  rebase: boolean
  retest: boolean
}

/**
 * Reasons that will not resolve on their own. Tidebot only attempts recovery
 * (branch update, CI re-run) for the other kind.
 */
const HARD_BLOCKER_PREFIXES = [
  'dependabot auto-approve disabled',
  'author is not dependabot',
  'blocked by label',
  'major version update',
  'changed files outside allowed dependency paths',
  'missing dependencies label',
]

function majorVersion(version: string): number {
  const match = version.match(/^(\d+)/)
  return match ? Number.parseInt(match[1], 10) : 0
}

function parseBumpVersions(text: string): { from: string; to: string } | null {
  const match = text.match(/from ([\d.]+(?:-[\w.]+)?) to ([\d.]+(?:-[\w.]+)?)/i)
  if (!match?.[1] || !match[2]) {
    return null
  }
  return { from: match[1], to: match[2] }
}

export function isDependabotAuthor(login: string | null | undefined): boolean {
  return login != null && DEPENDABOT_LOGINS.has(login)
}

export function isMajorDependabotUpdate(title: string, body = ''): boolean {
  const combined = `${title}\n${body}`
  if (/version-update:semver-major/i.test(combined)) {
    return true
  }

  const bump = parseBumpVersions(combined)
  if (!bump) {
    return false
  }

  return majorVersion(bump.to) > majorVersion(bump.from)
}

function pathsAreAllowed(
  paths: string[],
  allowedPathPrefixes: string[],
): boolean {
  return pathsAreWithin(paths, allowedPathPrefixes)
}

export function evaluateDependabotSafety(
  pr: PullRequest,
  tideConfig: BotConfig['tide'],
  dependabotConfig: BotConfig['dependabot'],
  checkRuns: CheckRun[],
  statuses: Status[],
  changedPaths: string[],
): DependabotSafetyDecision {
  const reasons: string[] = []

  if (!dependabotConfig.enabled || !dependabotConfig.autoApprove) {
    reasons.push('dependabot auto-approve disabled')
  }
  if (!isDependabotAuthor(pr.userLogin)) {
    reasons.push('author is not dependabot')
  }
  if (!isMergeReady(pr)) {
    reasons.push('PR is not merge-ready')
  }
  for (const label of tideConfig.blockedLabels) {
    if (hasLabel(pr, label)) {
      reasons.push(`blocked by label ${label}`)
    }
  }
  if (
    dependabotConfig.requireDependenciesLabel &&
    !hasLabel(pr, 'dependencies')
  ) {
    reasons.push('missing dependencies label')
  }
  if (
    !dependabotConfig.allowMajorUpdates &&
    isMajorDependabotUpdate(pr.title ?? '', pr.body ?? '')
  ) {
    reasons.push('major version update')
  }
  if (!pathsAreAllowed(changedPaths, dependabotConfig.allowedPathPrefixes)) {
    reasons.push('changed files outside allowed dependency paths')
  }

  for (const context of missingRequiredContexts(
    dependabotConfig.requiredContexts,
    checkRuns,
    statuses,
  )) {
    reasons.push(`missing passing check ${context}`)
  }

  return { safe: reasons.length === 0, reasons }
}

export function hasHardDependabotBlocker(reasons: string[]): boolean {
  return reasons.some((reason) =>
    HARD_BLOCKER_PREFIXES.some((prefix) => reason.startsWith(prefix)),
  )
}

function needsDependabotRebase(pr: PullRequest): boolean {
  return pr.mergeable_state === 'behind' || pr.mergeable_state === 'dirty'
}

export function evaluateDependabotRecovery(
  pr: PullRequest,
  dependabotConfig: BotConfig['dependabot'],
  checkRuns: CheckRun[],
  statuses: Status[],
): DependabotRecovery {
  const failed = failedRequiredContexts(
    dependabotConfig.requiredContexts,
    checkRuns,
    statuses,
  )
  const pending = pendingRequiredContexts(
    dependabotConfig.requiredContexts,
    checkRuns,
  )
  const missing = missingRequiredContexts(
    dependabotConfig.requiredContexts,
    checkRuns,
    statuses,
  )
  const missingOnly = missing.filter(
    (context) => !failed.includes(context) && !pending.includes(context),
  )
  const dependabotChecksComplete =
    pending.length === 0 && failed.length === 0 && missingOnly.length === 0

  // GitHub reports `unstable` instead of `behind` when the branch is behind base
  // and checks outside this plugin's required set are also failing.
  const rebase =
    needsDependabotRebase(pr) ||
    (dependabotChecksComplete &&
      pr.mergeable !== false &&
      pr.mergeable_state === 'unstable')

  const retest =
    !rebase &&
    pending.length === 0 &&
    (failed.length > 0 || missingOnly.length > 0)

  return { rebase, retest }
}
