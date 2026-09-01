import type { Octokit } from '@octokit/rest'
import type {
  BotConfig,
  CheckRun,
  PullRequest,
  RepoRef,
  ResolvedTidePolicy,
  Status,
  TideBlocker,
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

/** The one place a blocker becomes prose, so logs and replies agree. */
export function tideBlockerReason(blocker: TideBlocker): string {
  switch (blocker.kind) {
    case 'draft':
      return 'PR is draft'
    case 'not-open':
      return 'PR is not open'
    case 'conflict':
      return 'PR is not mergeable'
    case 'mergeable-state':
      return `mergeable_state=${blocker.state}`
    case 'auto-merge-disabled':
      return 'auto-merge disabled for this PR policy'
    case 'blocked-label':
      return `blocked by label ${blocker.label}`
    case 'missing-label':
      return `missing label ${blocker.label}`
    case 'missing-check':
      return `missing passing check ${blocker.context}`
  }
}

export function evaluateTide(
  pr: PullRequest,
  config: BotConfig['tide'],
  checkRuns: CheckRun[],
  statuses: Status[],
): TideDecision {
  const policy = resolveTidePolicy(pr, config)
  const blockers: TideBlocker[] = []

  if (pr.draft) {
    blockers.push({ kind: 'draft' })
  }
  if (pr.state !== 'open') {
    blockers.push({ kind: 'not-open', state: pr.state })
  }
  if (pr.mergeable === false) {
    blockers.push({ kind: 'conflict' })
  }
  if (pr.mergeable_state && pr.mergeable_state !== 'clean') {
    blockers.push({ kind: 'mergeable-state', state: pr.mergeable_state })
  }
  if (!policy.autoMerge) {
    blockers.push({ kind: 'auto-merge-disabled' })
  }

  for (const label of policy.blockedLabels) {
    if (hasLabel(pr, label)) {
      blockers.push({ kind: 'blocked-label', label })
    }
  }

  for (const label of policy.requiredLabels) {
    if (!hasLabel(pr, label)) {
      blockers.push({ kind: 'missing-label', label })
    }
  }

  for (const context of missingRequiredContexts(
    policy.requiredContexts,
    checkRuns,
    statuses,
    policy.allowSkippedContexts,
  )) {
    blockers.push({ kind: 'missing-check', context })
  }

  return {
    ready: blockers.length === 0,
    blockers,
    reasons: blockers.map(tideBlockerReason),
    policyName: policy.policyName,
  }
}
