import type { Octokit } from '@octokit/rest'
import { managedLabels } from '../core/config/defaults.js'
import type { BotConfig, RepoRef } from '../core/types.js'

export type LabelSyncResult = {
  created: string[]
  updated: string[]
  unchanged: string[]
}

/**
 * Create the labels Tidebot's rules refer to. Existing labels are only
 * recoloured or re-described, never deleted — a repository may already use
 * `lgtm` with its own colour and history.
 */
export async function syncRepositoryLabels(
  octokit: Octokit,
  { owner, repo }: RepoRef,
  config: BotConfig,
  options: { dryRun?: boolean } = {},
): Promise<LabelSyncResult> {
  const result: LabelSyncResult = { created: [], updated: [], unchanged: [] }

  const existing = new Map<string, { color: string; description: string }>()
  const iterator = octokit.paginate.iterator(
    octokit.rest.issues.listLabelsForRepo,
    { owner, repo, per_page: 100 },
  )
  for await (const { data } of iterator) {
    for (const label of data) {
      existing.set(label.name, {
        color: label.color,
        description: label.description ?? '',
      })
    }
  }

  const seen = new Set<string>()
  for (const label of managedLabels(config)) {
    if (seen.has(label.name)) {
      continue
    }
    seen.add(label.name)

    const current = existing.get(label.name)
    if (!current) {
      if (!options.dryRun) {
        await octokit.rest.issues.createLabel({
          owner,
          repo,
          name: label.name,
          color: label.color,
          description: label.description,
        })
      }
      result.created.push(label.name)
      continue
    }

    if (
      current.color === label.color &&
      current.description === label.description
    ) {
      result.unchanged.push(label.name)
      continue
    }

    if (!options.dryRun) {
      await octokit.rest.issues.updateLabel({
        owner,
        repo,
        name: label.name,
        color: label.color,
        description: label.description,
      })
    }
    result.updated.push(label.name)
  }

  return result
}
