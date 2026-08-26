import type { BotContext } from '../context.js'
import { getPullRequestChangedPaths, getPullRequestLabels } from '../github.js'
import { areaLabelsForPaths } from '../lib/area.js'
import { syncLabels } from '../lib/labels.js'

export async function applyAreaLabels(
  ctx: BotContext,
  pullNumber: number,
): Promise<void> {
  if (!ctx.config.plugins.area || ctx.config.area.rules.length === 0) {
    return
  }

  const [paths, currentLabels] = await Promise.all([
    getPullRequestChangedPaths(ctx.octokit, ctx.ref, pullNumber),
    getPullRequestLabels(ctx.octokit, ctx.ref, pullNumber),
  ])

  const desired = areaLabelsForPaths(paths, ctx.config.area.rules)
  await syncLabels(ctx.octokit, ctx.ref, pullNumber, currentLabels, desired, [
    ctx.config.area.labelPrefix,
  ])
}
