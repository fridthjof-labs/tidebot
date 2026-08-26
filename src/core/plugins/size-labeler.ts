import type { BotContext } from '../context.js'
import { syncLabels } from '../lib/labels.js'
import { sizeLabelForDiff } from '../lib/size.js'
import type { PullRequest } from '../types.js'

export async function applySizeLabel(
  ctx: BotContext,
  pullNumber: number,
  pr: PullRequest,
): Promise<void> {
  if (!ctx.config.plugins.size) {
    return
  }

  const currentLabels = pr.labels
    .map((label) => label.name ?? '')
    .filter(Boolean)
  const desired = [
    sizeLabelForDiff(pr.additions + pr.deletions, ctx.config.size),
  ]

  await syncLabels(ctx.octokit, ctx.ref, pullNumber, currentLabels, desired, [
    ctx.config.size.labelPrefix,
  ])
}
