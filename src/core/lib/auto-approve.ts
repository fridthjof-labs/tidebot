import type {
  AutoApproveRule,
  BotConfig,
  CheckRun,
  PullRequest,
  Status,
} from '../types.js'
import { missingRequiredContexts } from './checks.js'
import { matchesAnyGlob, pathsAreWithin } from './glob.js'

export type AutoApproveDecision = {
  safe: boolean
  /** Name of the rule that matched, when one did. */
  rule?: string
  reasons: string[]
}

export function hasLabel(pr: PullRequest, label: string): boolean {
  return pr.labels.some((entry) => entry.name === label)
}

export function isMergeReady(pr: PullRequest): boolean {
  if (pr.draft || pr.state !== 'open' || pr.mergeable === false) {
    return false
  }
  return !pr.mergeable_state || pr.mergeable_state === 'clean'
}

export function missingApprovalLabels(
  pr: PullRequest,
  requiredLabels: string[],
): string[] {
  return requiredLabels.filter((label) => !hasLabel(pr, label))
}

/**
 * Evaluate one declarative rule. Every configured facet must match; an unset
 * facet imposes no constraint. `parse.ts` refuses a rule that constrains
 * neither authors nor paths, so a matching rule always narrows something.
 */
export function evaluateRule(
  rule: AutoApproveRule,
  input: {
    pr: PullRequest
    tide: BotConfig['tide']
    checkRuns: CheckRun[]
    statuses: Status[]
    changedPaths: string[]
    /** `rule.authors` with `${bot}` already expanded. */
    authors: string[]
  },
): AutoApproveDecision {
  const { pr, tide, checkRuns, statuses, changedPaths, authors } = input
  const reasons: string[] = []

  if (authors.length > 0 && !authors.includes(pr.userLogin ?? '')) {
    reasons.push(`author ${pr.userLogin ?? 'unknown'} not in rule authors`)
  }
  if (!isMergeReady(pr)) {
    reasons.push('PR is not merge-ready')
  }
  for (const label of tide.blockedLabels) {
    if (hasLabel(pr, label)) {
      reasons.push(`blocked by label ${label}`)
    }
  }
  for (const label of rule.blockedLabels ?? []) {
    if (hasLabel(pr, label)) {
      reasons.push(`blocked by label ${label}`)
    }
  }
  if (
    rule.paths &&
    !pathsAreWithin(changedPaths, rule.paths, rule.excludePaths)
  ) {
    reasons.push('changed files outside the rule paths')
  }
  if (
    !rule.paths &&
    rule.excludePaths &&
    changedPaths.some((path) => matchesAnyGlob(path, rule.excludePaths ?? []))
  ) {
    reasons.push('changed files inside the rule excludePaths')
  }
  if (
    rule.maxChangedLines !== undefined &&
    pr.additions + pr.deletions > rule.maxChangedLines
  ) {
    reasons.push(`diff larger than ${rule.maxChangedLines} lines`)
  }

  for (const context of missingRequiredContexts(
    rule.requiredContexts ?? [],
    checkRuns,
    statuses,
  )) {
    reasons.push(`missing passing check ${context}`)
  }

  return { safe: reasons.length === 0, rule: rule.name, reasons }
}

/** First rule that fully matches, or a decision explaining why none did. */
export function evaluateAutoApprove(input: {
  pr: PullRequest
  config: BotConfig
  checkRuns: CheckRun[]
  statuses: Status[]
  changedPaths: string[]
  /** Resolves each rule's `authors`, expanding the `${bot}` placeholder. */
  resolveAuthors: (rule: AutoApproveRule) => string[]
}): AutoApproveDecision {
  const { pr, config, checkRuns, statuses, changedPaths, resolveAuthors } =
    input

  if (!config.plugins.autoApprove) {
    return { safe: false, reasons: ['auto-approve disabled'] }
  }

  const failures: string[] = []
  for (const rule of config.autoApprove.rules) {
    const decision = evaluateRule(rule, {
      pr,
      tide: config.tide,
      checkRuns,
      statuses,
      changedPaths,
      authors: resolveAuthors(rule),
    })
    if (decision.safe) {
      return decision
    }
    failures.push(`${rule.name}: ${decision.reasons.join('; ')}`)
  }

  return { safe: false, reasons: failures }
}
