import type { Octokit } from '@octokit/rest'
import type { RepoRef } from '../types.js'

export type RepositoryLabel = {
  name: string
  color: string
  description: string
}

export async function addLabelsToIssue(
  octokit: Octokit,
  { owner, repo }: RepoRef,
  issueNumber: number,
  labels: string[],
): Promise<void> {
  await octokit.rest.issues.addLabels({
    owner,
    repo,
    issue_number: issueNumber,
    labels,
  })
}

export async function removeLabelFromIssue(
  octokit: Octokit,
  { owner, repo }: RepoRef,
  issueNumber: number,
  name: string,
): Promise<void> {
  await octokit.rest.issues.removeLabel({
    owner,
    repo,
    issue_number: issueNumber,
    name,
  })
}

export async function listRepositoryLabels(
  octokit: Octokit,
  { owner, repo }: RepoRef,
): Promise<RepositoryLabel[]> {
  const labels = await octokit.paginate(octokit.rest.issues.listLabelsForRepo, {
    owner,
    repo,
    per_page: 100,
  })
  return labels.map((label) => ({
    name: label.name,
    color: label.color,
    description: label.description ?? '',
  }))
}

export async function createRepositoryLabel(
  octokit: Octokit,
  { owner, repo }: RepoRef,
  label: RepositoryLabel,
): Promise<void> {
  await octokit.rest.issues.createLabel({
    owner,
    repo,
    name: label.name,
    color: label.color,
    description: label.description,
  })
}

export async function updateRepositoryLabel(
  octokit: Octokit,
  { owner, repo }: RepoRef,
  label: RepositoryLabel,
): Promise<void> {
  await octokit.rest.issues.updateLabel({
    owner,
    repo,
    name: label.name,
    color: label.color,
    description: label.description,
  })
}
