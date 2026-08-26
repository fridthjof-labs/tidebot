import type { BotContext } from '../context.js'
import { getChecksForRef, upsertIssueCommentWithMarker } from '../github.js'
import { autoMergeFailedMarker, autoMergeMarker } from '../lib/markers.js'
import { evaluateTide } from '../lib/tide.js'
import type { CheckRun, PullRequest, Status } from '../types.js'

/**
 * Expected outcomes, not failures: another merge won the race, the PR closed,
 * or `sha` no longer matches because someone pushed. Each resolves itself —
 * a new push re-runs checks and Tide evaluates the new head.
 */
function isBenignMergeError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  const message = error.message.toLowerCase()
  return (
    message.includes('merge already in progress') ||
    message.includes('pull request is not mergeable') ||
    message.includes('head branch was modified') ||
    message.includes('was closed') ||
    ('status' in error && error.status === 409)
  )
}

export async function maybeAutoMerge(
  ctx: BotContext,
  pullNumber: number,
  pr: PullRequest,
  preloadedChecks?: { checkRuns: CheckRun[]; statuses: Status[] },
): Promise<void> {
  if (!ctx.config.plugins.tide) {
    return
  }

  const { checkRuns, statuses } =
    preloadedChecks ??
    (await getChecksForRef(ctx.octokit, ctx.ref, pr.head.sha))

  if (!evaluateTide(pr, ctx.config.tide, checkRuns, statuses).ready) {
    return
  }

  const mergeMethod = ctx.config.tide.mergeMethod
  try {
    await ctx.octokit.rest.pulls.merge({
      owner: ctx.ref.owner,
      repo: ctx.ref.repo,
      pull_number: pullNumber,
      merge_method: mergeMethod,
      // The checks above were evaluated against this commit. Without `sha`,
      // a push landing between that evaluation and this call would merge code
      // nobody reviewed; GitHub returns 409 instead, and the new head's own
      // check_suite event re-runs the gate.
      sha: pr.head.sha,
    })
    const marker = autoMergeMarker(pr.head.sha)
    await upsertIssueCommentWithMarker(
      ctx.octokit,
      ctx.ref,
      pullNumber,
      marker,
      `Auto-merged with \`${mergeMethod}\` after required labels and checks passed.\n\n${marker}`,
      ctx.identity.login,
    )
  } catch (error) {
    if (isBenignMergeError(error)) {
      return
    }

    const marker = autoMergeFailedMarker(pr.head.sha)
    await upsertIssueCommentWithMarker(
      ctx.octokit,
      ctx.ref,
      pullNumber,
      marker,
      `Auto-merge failed: ${error instanceof Error ? error.message : String(error)}\n\n${marker}`,
      ctx.identity.login,
    )
  }
}
