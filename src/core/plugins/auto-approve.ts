import type { BotContext } from '../context.js'
import { ruleAuthors } from '../context.js'
import {
  addLabelsToIssue,
  getChecksForRef,
  getPullRequestChangedPaths,
} from '../github.js'
import {
  evaluateAutoApprove,
  missingApprovalLabels,
} from '../lib/auto-approve.js'
import type { CheckRun, PullRequest, Status } from '../types.js'

/**
 * Apply the Tide merge labels when a declarative rule matches — the generic
 * replacement for per-repository "docs-only" and "generated content" rules.
 * It only adds labels; the merge itself still goes through Tide's own gate.
 */
export async function maybeAutoApprove(
  ctx: BotContext,
  pullNumber: number,
  pr: PullRequest,
  preloaded?: {
    checkRuns: CheckRun[]
    statuses: Status[]
    changedPaths: string[]
  },
): Promise<void> {
  if (
    !ctx.config.plugins.autoApprove ||
    ctx.config.autoApprove.rules.length === 0
  ) {
    return
  }

  const [{ checkRuns, statuses }, changedPaths] = preloaded
    ? [
        { checkRuns: preloaded.checkRuns, statuses: preloaded.statuses },
        preloaded.changedPaths,
      ]
    : await Promise.all([
        getChecksForRef(ctx.octokit, ctx.ref, pr.head.sha),
        getPullRequestChangedPaths(ctx.octokit, ctx.ref, pullNumber),
      ])

  const decision = evaluateAutoApprove({
    pr,
    config: ctx.config,
    checkRuns,
    statuses,
    changedPaths,
    resolveAuthors: ruleAuthors(ctx),
  })

  if (!decision.safe) {
    return
  }

  const toAdd = missingApprovalLabels(pr, ctx.config.tide.requiredLabels)
  if (toAdd.length === 0) {
    return
  }

  await addLabelsToIssue(ctx.octokit, ctx.ref, pullNumber, toAdd)

  for (const label of toAdd) {
    pr.labels.push({ name: label })
  }
}
