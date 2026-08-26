import type { Octokit } from '@octokit/rest'
import type { BotContext } from '../context.js'
import { commentOnIssue, fetchPullRequest } from '../github.js'
import { isBotComment } from '../lib/commands.js'
import type { PullRequest, RepoRef } from '../types.js'

const DAY_MS = 24 * 60 * 60 * 1000

function hasAnyLabel(pr: PullRequest, labels: string[]): boolean {
  return pr.labels.some((entry) => labels.includes(entry.name ?? ''))
}

function daysSince(
  isoDate: string | null | undefined,
  now = Date.now(),
): number {
  if (!isoDate) {
    return 0
  }
  return (now - new Date(isoDate).getTime()) / DAY_MS
}

/**
 * Inactivity is measured from the last commit on the PR branch, not
 * `updated_at` — the bot's own comments and CI runs keep bumping that, which
 * would make a genuinely abandoned pull request look active forever.
 */
export function resolveInactiveDays(
  lastPushAt: string | null | undefined,
  updatedAt: string | null | undefined,
  now = Date.now(),
): number {
  return daysSince(lastPushAt ?? updatedAt, now)
}

async function getLastPushDate(
  octokit: Octokit,
  { owner, repo }: RepoRef,
  headSha: string,
): Promise<string | null> {
  try {
    const { data } = await octokit.rest.git.getCommit({
      owner,
      repo,
      commit_sha: headSha,
    })
    return data.committer?.date ?? data.author?.date ?? null
  } catch {
    return null
  }
}

/**
 * The most recent comment from a human.
 *
 * Bot comments are excluded deliberately: Tidebot's own pipeline summary and
 * CI notifications would otherwise keep an abandoned pull request looking
 * alive forever, which is the reason `updated_at` is unusable here.
 *
 * A failure is reported rather than swallowed. Returning "no comments" when
 * the API refused would let a transient error close a pull request somebody
 * is actively discussing — the caller must be able to tell the two apart.
 */
type HumanActivity =
  | { known: true; at: string | null }
  | { known: false; reason: string }

async function lastHumanCommentAt(
  ctx: BotContext,
  pullNumber: number,
): Promise<HumanActivity> {
  try {
    const { data: comments } = await ctx.octokit.rest.issues.listComments({
      owner: ctx.ref.owner,
      repo: ctx.ref.repo,
      issue_number: pullNumber,
      per_page: 100,
      sort: 'created',
      direction: 'desc',
    })
    return {
      known: true,
      at:
        comments.find((comment) => !isBotComment(comment.user?.login))
          ?.created_at ?? null,
    }
  } catch (error) {
    return {
      known: false,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function applyStaleRules(
  ctx: BotContext,
  pullNumber: number,
  pr: PullRequest,
  now = Date.now(),
): Promise<void> {
  const { stale } = ctx.config
  if (!ctx.config.plugins.stale) {
    return
  }
  if (pr.draft || pr.state !== 'open') {
    return
  }
  if (hasAnyLabel(pr, stale.exemptLabels)) {
    return
  }

  const alreadyStale = pr.labels.some(
    (entry) => entry.name === stale.staleLabel,
  )
  const lastPushAt = await getLastPushDate(ctx.octokit, ctx.ref, pr.head.sha)
  const branchIdleDays = resolveInactiveDays(lastPushAt, pr.updated_at, now)

  // The cheap path: a branch touched recently cannot be stale under any
  // reading, so the extra comment lookup below is skipped entirely.
  if (!alreadyStale && branchIdleDays < stale.daysUntilStale) {
    return
  }

  // "Comment or push to keep it open" has to be true, so a human comment
  // counts as activity exactly like a commit does.
  const activity = await lastHumanCommentAt(ctx, pullNumber)
  if (!activity.known) {
    // Labelling or closing now would be a decision made on incomplete
    // evidence, and closing is not reversible by the person it surprises.
    console.error(
      JSON.stringify({
        message: 'tidebot stale check skipped: could not read comments',
        repository: `${ctx.ref.owner}/${ctx.ref.repo}`,
        pull: pullNumber,
        error: activity.reason,
      }),
    )
    return
  }

  const inactiveDays = activity.at
    ? Math.min(branchIdleDays, daysSince(activity.at, now))
    : branchIdleDays

  if (inactiveDays < stale.daysUntilStale) {
    if (alreadyStale) {
      // Someone came back. Withdraw the warning rather than counting down.
      await ctx.octokit.rest.issues.removeLabel({
        owner: ctx.ref.owner,
        repo: ctx.ref.repo,
        issue_number: pullNumber,
        name: stale.staleLabel,
      })
    }
    return
  }

  if (!alreadyStale) {
    await ctx.octokit.rest.issues.addLabels({
      owner: ctx.ref.owner,
      repo: ctx.ref.repo,
      issue_number: pullNumber,
      labels: [stale.staleLabel],
    })
    await commentOnIssue(
      ctx.octokit,
      ctx.ref,
      pullNumber,
      `Marked stale after ${stale.daysUntilStale} days without activity. Comment or push to keep it open.`,
    )
    return
  }

  if (inactiveDays >= stale.daysUntilStale + stale.daysUntilClose) {
    await ctx.octokit.rest.issues.update({
      owner: ctx.ref.owner,
      repo: ctx.ref.repo,
      issue_number: pullNumber,
      state: 'closed',
      state_reason: 'not_planned',
    })
    await commentOnIssue(
      ctx.octokit,
      ctx.ref,
      pullNumber,
      `Closed as stale after ${stale.daysUntilClose} additional days without activity.`,
    )
  }
}

export async function sweepStalePullRequests(ctx: BotContext): Promise<number> {
  if (!ctx.config.plugins.stale) {
    return 0
  }

  let processed = 0
  const iterator = ctx.octokit.paginate.iterator(ctx.octokit.rest.pulls.list, {
    owner: ctx.ref.owner,
    repo: ctx.ref.repo,
    state: 'open',
    per_page: 100,
  })

  for await (const { data: pulls } of iterator) {
    for (const summary of pulls) {
      const pr = await fetchPullRequest(ctx.octokit, ctx.ref, summary.number)
      await applyStaleRules(ctx, summary.number, pr)
      processed += 1
    }
  }

  return processed
}
