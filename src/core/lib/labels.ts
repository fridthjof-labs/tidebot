import type { Octokit } from '@octokit/rest'
import type { RepoRef } from '../types.js'

/**
 * Converge the labels Tidebot owns for a pull request. Only labels under
 * `managedPrefixes` are removed, so labels a human added stay put.
 */
export async function syncLabels(
  octokit: Octokit,
  { owner, repo }: RepoRef,
  issueNumber: number,
  currentLabels: string[],
  desiredLabels: string[],
  managedPrefixes: string[],
): Promise<void> {
  const desired = new Set(desiredLabels)
  const managed = currentLabels.filter((label) =>
    managedPrefixes.some((prefix) => label.startsWith(prefix)),
  )

  const toAdd = [...desired].filter((label) => !currentLabels.includes(label))
  const toRemove = managed.filter((label) => !desired.has(label))

  if (toAdd.length > 0) {
    await octokit.rest.issues.addLabels({
      owner,
      repo,
      issue_number: issueNumber,
      labels: toAdd,
    })
  }

  for (const label of toRemove) {
    await octokit.rest.issues.removeLabel({
      owner,
      repo,
      issue_number: issueNumber,
      name: label,
    })
  }
}

export async function setWorkflowLabel(
  octokit: Octokit,
  { owner, repo }: RepoRef,
  issueNumber: number,
  currentLabels: string[],
  label: string,
  enabled: boolean,
): Promise<void> {
  const hasLabel = currentLabels.includes(label)
  if (enabled && !hasLabel) {
    await octokit.rest.issues.addLabels({
      owner,
      repo,
      issue_number: issueNumber,
      labels: [label],
    })
    return
  }

  if (!enabled && hasLabel) {
    await octokit.rest.issues.removeLabel({
      owner,
      repo,
      issue_number: issueNumber,
      name: label,
    })
  }
}
