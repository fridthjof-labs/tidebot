import type { Octokit } from '@octokit/rest'
import { addLabelsToIssue, removeLabelFromIssue } from '../github/labels.js'
import type { RepoRef } from '../types.js'
import { hasHttpStatus, httpMessage } from './http.js'

/**
 * GitHub answers 404 for a label the issue does not carry, for an issue that
 * does not exist, and for a repository it cannot see. Only the first is
 * survivable, and only the first names the label in its message. Matching on
 * the status code alone would hide a wrong issue number or a lost permission.
 */
function isLabelAlreadyGone(error: unknown): boolean {
  return (
    hasHttpStatus(error, 404) &&
    httpMessage(error).includes('label does not exist')
  )
}

/**
 * Remove a label, treating "already gone" as success.
 *
 * Label decisions are made from a snapshot that a human, a concurrent run, or
 * a second Tidebot runtime can invalidate before the write lands. The removal
 * is one step of a converging sync, so failing it would abandon the rest.
 */
export async function removeLabelIfPresent(
  octokit: Octokit,
  { owner, repo }: RepoRef,
  issueNumber: number,
  name: string,
): Promise<void> {
  try {
    await removeLabelFromIssue(octokit, { owner, repo }, issueNumber, name)
  } catch (error) {
    if (isLabelAlreadyGone(error)) {
      return
    }
    throw error
  }
}

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
    await addLabelsToIssue(octokit, { owner, repo }, issueNumber, toAdd)
  }

  for (const label of toRemove) {
    await removeLabelIfPresent(octokit, { owner, repo }, issueNumber, label)
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
    await addLabelsToIssue(octokit, { owner, repo }, issueNumber, [label])
    return
  }

  if (!enabled && hasLabel) {
    await removeLabelIfPresent(octokit, { owner, repo }, issueNumber, label)
  }
}
