import type { BotContext } from '../context.js'
import { proposedDiffFingerprint } from '../github.js'
import { hasLabel } from '../lib/auto-approve.js'
import { removeLabelIfPresent } from '../lib/labels.js'
import { resolveTidePolicy } from '../lib/tide.js'
import type { PullRequest } from '../types.js'

export type PushEvent = {
  /** Head before the push, from the `synchronize` payload. */
  before?: string | null
  after?: string | null
}

/**
 * Withdraw review labels when a push changes what the pull request proposes.
 *
 * The labels are the merge gate, so they have to be tied to a revision:
 * otherwise a `/lgtm` stays valid over any subsequent push.
 *
 * The test is the branch's own diff rather than the head sha or the pusher. An
 * "update branch" merge and a clean rebase move the head without changing what
 * is proposed, and `autoRebaseWhenBehind` performs exactly those, so treating
 * them as new work would withdraw the intent Tidebot is acting on.
 *
 * `push` is required: without the payload every push compares as changed.
 */
export async function dismissStaleMergeLabels(
  ctx: BotContext,
  pullNumber: number,
  pr: PullRequest,
  push: PushEvent,
): Promise<string[]> {
  const configured = ctx.config.tide.dismissLabelsOnPush
  if (configured.length === 0) {
    return []
  }

  // A matching policy's required labels are this pull request's gate too, so
  // they are withdrawn alongside the configured ones.
  const gate = new Set([
    ...configured,
    ...resolveTidePolicy(pr, ctx.config.tide).requiredLabels,
  ])

  // Nothing to withdraw is the common case, and it must cost no API calls.
  const present = [...gate].filter((label) => hasLabel(pr, label))
  if (present.length === 0) {
    return []
  }

  if (await proposesTheSameChange(ctx, pr, push)) {
    return []
  }

  for (const label of present) {
    await removeLabelIfPresent(ctx.octokit, ctx.ref, pullNumber, label)
  }

  return present
}

async function proposesTheSameChange(
  ctx: BotContext,
  pr: PullRequest,
  push: PushEvent,
): Promise<boolean> {
  const base = pr.base?.ref
  const before = push.before
  const after = push.after ?? pr.head.sha
  if (!base || !before || before === after) {
    return false
  }

  const [previous, current] = await Promise.all([
    proposedDiffFingerprint(ctx.octokit, ctx.ref, base, before),
    proposedDiffFingerprint(ctx.octokit, ctx.ref, base, after),
  ])

  // An unreadable comparison counts as changed. The opposite default would
  // keep an approval across a push that could not be inspected.
  if (previous === null || current === null) {
    return false
  }

  return previous === current
}
