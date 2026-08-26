import type { Octokit } from '@octokit/rest'
import type {
  BotConfig,
  CheckRun,
  PullRequest,
  RepoRef,
  ResolvedTidePolicy,
  Status,
  TideDecision,
} from '../types.js'
import { hasLabel } from './auto-approve.js'
import { missingRequiredContexts } from './checks.js'
import { updateBranch } from './rebase.js'

function hasMergeIntent(pr: PullRequest, config: BotConfig['tide']): boolean {
  return config.requiredLabels.every((label) => hasLabel(pr, label))
}

/**
 * When the base branch moves, bring already-approved PRs forward so their
 * checks re-run without a manual "Update branch" click. Only PRs that already
 * carry the full merge intent are touched.
 */
export async function maybeRebaseIfBehind(
  octokit: Octokit,
  ref: RepoRef,
  pullNumber: number,
  pr: PullRequest,
  config: BotConfig,
  defaultBranch: string,
): Promise<boolean> {
  if (!config.tide.autoRebaseWhenBehind) {
    return false
  }
  if (pr.mergeable_state !== 'behind') {
    return false
  }
  if (!hasMergeIntent(pr, config.tide)) {
    return false
  }
  for (const label of config.tide.blockedLabels) {
    if (hasLabel(pr, label)) {
      return false
    }
  }

  const result = await updateBranch(
    octokit,
    ref,
    pullNumber,
    pr,
    config,
    defaultBranch,
  )
  return result.updated
}

export function resolveTidePolicy(
  pr: PullRequest,
  config: BotConfig['tide'],
): ResolvedTidePolicy {
  const base: ResolvedTidePolicy = {
    requiredLabels: config.requiredLabels,
    blockedLabels: config.blockedLabels,
    requiredContexts: config.requiredContexts,
    allowSkippedContexts: [],
    autoMerge: true,
  }

  for (const policy of config.policies) {
    if (policy.matchLabels.every((label) => hasLabel(pr, label))) {
      return {
        requiredLabels: policy.requiredLabels ?? base.requiredLabels,
        blockedLabels: base.blockedLabels,
        requiredContexts: policy.requiredContexts,
        allowSkippedContexts: policy.allowSkippedContexts ?? [],
        autoMerge: policy.autoMerge ?? true,
        policyName: policy.name,
      }
    }
  }

  return base
}

export function evaluateTide(
  pr: PullRequest,
  config: BotConfig['tide'],
  checkRuns: CheckRun[],
  statuses: Status[],
): TideDecision {
  const policy = resolveTidePolicy(pr, config)
  const reasons: string[] = []

  if (pr.draft) {
    reasons.push('PR is draft')
  }
  if (pr.state !== 'open') {
    reasons.push('PR is not open')
  }
  if (pr.mergeable === false) {
    reasons.push('PR is not mergeable')
  }
  if (pr.mergeable_state && pr.mergeable_state !== 'clean') {
    reasons.push(`mergeable_state=${pr.mergeable_state}`)
  }
  if (!policy.autoMerge) {
    reasons.push('auto-merge disabled for this PR policy')
  }

  for (const label of policy.blockedLabels) {
    if (hasLabel(pr, label)) {
      reasons.push(`blocked by label ${label}`)
    }
  }

  for (const label of policy.requiredLabels) {
    if (!hasLabel(pr, label)) {
      reasons.push(`missing label ${label}`)
    }
  }

  for (const context of missingRequiredContexts(
    policy.requiredContexts,
    checkRuns,
    statuses,
    policy.allowSkippedContexts,
  )) {
    reasons.push(`missing passing check ${context}`)
  }

  return { ready: reasons.length === 0, reasons, policyName: policy.policyName }
}
