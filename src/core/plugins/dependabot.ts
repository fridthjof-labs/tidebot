import type { BotContext } from '../context.js'
import {
  getChecksForRef,
  getPullRequestChangedPaths,
  hasIssueCommentMarker,
  rerunFailedWorkflowsForRef,
  upsertIssueCommentWithMarker,
} from '../github.js'
import { missingApprovalLabels } from '../lib/auto-approve.js'
import {
  evaluateDependabotRecovery,
  evaluateDependabotSafety,
  hasHardDependabotBlocker,
  isDependabotAuthor,
} from '../lib/dependabot.js'
import { recoveryMarker } from '../lib/markers.js'
import { updateBranch } from '../lib/rebase.js'
import type { CheckRun, PullRequest, Status } from '../types.js'

const MAINTAINER_REBASE_HINT =
  'This Dependabot PR has merge conflicts with the base branch. A maintainer must comment @dependabot rebase or @dependabot recreate — a GitHub App cannot trigger that command.'

async function postRecoveryComment(
  ctx: BotContext,
  pullNumber: number,
  marker: string,
  body: string,
): Promise<void> {
  await upsertIssueCommentWithMarker(
    ctx.octokit,
    ctx.ref,
    pullNumber,
    marker,
    `${body}\n\n${marker}`,
    ctx.identity.login,
  )
}

async function tryUpdateDependabotBranch(
  ctx: BotContext,
  pullNumber: number,
  pr: PullRequest,
): Promise<{ updated: boolean; message: string }> {
  if (pr.mergeable_state === 'dirty') {
    return { updated: false, message: MAINTAINER_REBASE_HINT }
  }

  const result = await updateBranch(
    ctx.octokit,
    ctx.ref,
    pullNumber,
    pr,
    ctx.config,
    ctx.defaultBranch,
  )
  return {
    updated: result.updated,
    message: result.updated
      ? `Updated branch onto base. ${result.message}`
      : `Branch update failed. ${result.message}`,
  }
}

/**
 * A Dependabot PR that is not yet safe is often one branch update or CI re-run
 * away from being safe. Hard blockers (major bumps, unexpected paths, a hold)
 * are left for a human instead.
 */
async function maybeRecoverDependabot(
  ctx: BotContext,
  pullNumber: number,
  pr: PullRequest,
  safetyReasons: string[],
  checkRuns: CheckRun[],
  statuses: Status[],
): Promise<void> {
  if (hasHardDependabotBlocker(safetyReasons)) {
    return
  }

  const recovery = evaluateDependabotRecovery(
    pr,
    ctx.config.dependabot,
    checkRuns,
    statuses,
  )

  if (recovery.rebase) {
    const result = await tryUpdateDependabotBranch(ctx, pullNumber, pr)
    await postRecoveryComment(
      ctx,
      pullNumber,
      recoveryMarker('rebase', pr.head.sha),
      result.message,
    )
    return
  }

  if (!recovery.retest) {
    return
  }

  const marker = recoveryMarker('retest', pr.head.sha)
  if (
    await hasIssueCommentMarker(
      ctx.octokit,
      ctx.ref,
      pullNumber,
      marker,
      ctx.identity.login,
    )
  ) {
    return
  }

  const { rerunCount } = await rerunFailedWorkflowsForRef(
    ctx.octokit,
    ctx.ref,
    pr.head.sha,
  )
  if (rerunCount > 0) {
    await postRecoveryComment(
      ctx,
      pullNumber,
      marker,
      `Re-running failed CI (${rerunCount} workflow${rerunCount === 1 ? '' : 's'}).`,
    )
    return
  }

  const branchResult = await tryUpdateDependabotBranch(ctx, pullNumber, pr)
  await postRecoveryComment(
    ctx,
    pullNumber,
    marker,
    branchResult.updated
      ? `No failed workflows to re-run; ${branchResult.message}`
      : branchResult.message,
  )
}

export async function maybeAutoApproveDependabot(
  ctx: BotContext,
  pullNumber: number,
  pr: PullRequest,
  preloaded?: {
    checkRuns: CheckRun[]
    statuses: Status[]
    changedPaths: string[]
  },
): Promise<void> {
  if (!ctx.config.plugins.dependabot || !isDependabotAuthor(pr.userLogin)) {
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

  const safety = evaluateDependabotSafety(
    pr,
    ctx.config.tide,
    ctx.config.dependabot,
    checkRuns,
    statuses,
    changedPaths,
  )

  if (safety.safe) {
    const toAdd = missingApprovalLabels(pr, ctx.config.tide.requiredLabels)
    if (toAdd.length === 0) {
      return
    }

    await ctx.octokit.rest.issues.addLabels({
      owner: ctx.ref.owner,
      repo: ctx.ref.repo,
      issue_number: pullNumber,
      labels: toAdd,
    })
    for (const label of toAdd) {
      pr.labels.push({ name: label })
    }
    return
  }

  await maybeRecoverDependabot(
    ctx,
    pullNumber,
    pr,
    safety.reasons,
    checkRuns,
    statuses,
  )
}
