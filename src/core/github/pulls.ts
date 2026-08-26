import type { Octokit } from '@octokit/rest'
import type { PullRequest, RepoRef } from '../types.js'

export async function getRepository(
  octokit: Octokit,
  { owner, repo }: RepoRef,
): Promise<{ defaultBranch: string; private: boolean }> {
  const { data } = await octokit.rest.repos.get({ owner, repo })
  return { defaultBranch: data.default_branch, private: data.private }
}

export async function getPullRequestLabels(
  octokit: Octokit,
  { owner, repo }: RepoRef,
  pullNumber: number,
): Promise<string[]> {
  const { data } = await octokit.rest.issues.listLabelsOnIssue({
    owner,
    repo,
    issue_number: pullNumber,
  })
  return data.map((label) => label.name ?? '').filter(Boolean)
}

export async function getPullRequestChangedPaths(
  octokit: Octokit,
  { owner, repo }: RepoRef,
  pullNumber: number,
): Promise<string[]> {
  const paths: string[] = []
  const iterator = octokit.paginate.iterator(octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  })

  for await (const { data: files } of iterator) {
    for (const file of files) {
      paths.push(file.filename)
    }
  }

  return paths
}

export async function findOpenPullRequestForSha(
  octokit: Octokit,
  { owner, repo }: RepoRef,
  headSha: string,
): Promise<number | null> {
  const { data: pulls } = await octokit.rest.pulls.list({
    owner,
    repo,
    state: 'open',
    per_page: 100,
  })

  return pulls.find((pull) => pull.head.sha === headSha)?.number ?? null
}

export async function updatePullRequestBranch(
  octokit: Octokit,
  { owner, repo }: RepoRef,
  pullNumber: number,
  updateMethod: 'merge' | 'rebase' = 'merge',
): Promise<{ updated: boolean; message: string }> {
  try {
    if (updateMethod === 'merge') {
      const { data, status } = await octokit.rest.pulls.updateBranch({
        owner,
        repo,
        pull_number: pullNumber,
      })

      return {
        updated: status === 202,
        message:
          data.message ??
          (status === 202
            ? 'Branch update requested.'
            : 'Branch is already up to date with the base branch.'),
      }
    }

    const { data: pr } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: pullNumber,
    })

    await octokit.graphql(
      `mutation UpdatePullRequestBranch($input: UpdatePullRequestBranchInput!) {
        updatePullRequestBranch(input: $input) {
          pullRequest { number }
        }
      }`,
      {
        input: {
          pullRequestId: pr.node_id,
          expectedHeadOid: pr.head.sha,
          updateMethod: 'REBASE',
        },
      },
    )

    return { updated: true, message: 'Branch rebased onto base.' }
  } catch (error) {
    const message =
      error instanceof Error &&
      (error.message.includes(
        'merge conflict between base and head (updatePullRequestBranch)',
      ) ||
        ('status' in error && error.status === 422))
        ? 'Cannot update branch — resolve merge conflicts with the base branch first.'
        : error instanceof Error
          ? error.message
          : 'Failed to update branch.'
    return { updated: false, message }
  }
}

function isUnprocessableReviewError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    error.status === 422
  )
}

export async function submitPullRequestApproval(
  octokit: Octokit,
  { owner, repo }: RepoRef,
  pullNumber: number,
  commitId: string,
  body: string,
): Promise<{ approved: boolean; message: string }> {
  try {
    await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: pullNumber,
      commit_id: commitId,
      event: 'APPROVE',
      body,
    })
    return { approved: true, message: 'PR approved.' }
  } catch (error) {
    if (isUnprocessableReviewError(error)) {
      return { approved: true, message: 'PR already approved.' }
    }
    return {
      approved: false,
      message: error instanceof Error ? error.message : 'Failed to approve PR.',
    }
  }
}

/** Withdraw this bot's own approval — never another app's or a human's. */
export async function dismissBotPullRequestApproval(
  octokit: Octokit,
  { owner, repo }: RepoRef,
  pullNumber: number,
  message: string,
  botLogin: string,
): Promise<{ dismissed: boolean; message: string }> {
  try {
    const { data: reviews } = await octokit.rest.pulls.listReviews({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
    })

    const botApproval = [...reviews]
      .reverse()
      .find(
        (review) =>
          review.user?.login === botLogin && review.state === 'APPROVED',
      )
    if (!botApproval) {
      return { dismissed: false, message: 'No bot approval to dismiss.' }
    }

    await octokit.rest.pulls.dismissReview({
      owner,
      repo,
      pull_number: pullNumber,
      review_id: botApproval.id,
      message,
    })
    return { dismissed: true, message: 'Approval dismissed.' }
  } catch (error) {
    return {
      dismissed: false,
      message:
        error instanceof Error ? error.message : 'Failed to dismiss approval.',
    }
  }
}

export async function fetchPullRequest(
  octokit: Octokit,
  { owner, repo }: RepoRef,
  pullNumber: number,
): Promise<PullRequest> {
  const { data } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
  })

  return {
    id: data.node_id,
    draft: data.draft ?? false,
    state: data.state,
    title: data.title,
    body: data.body,
    mergeable: data.mergeable,
    mergeable_state: data.mergeable_state,
    labels: data.labels.map((label) => ({ name: label.name })),
    additions: data.additions,
    deletions: data.deletions,
    updated_at: data.updated_at,
    base: { ref: data.base?.ref ?? null },
    head: {
      sha: data.head.sha,
      ref: data.head.ref,
      repoFullName: data.head.repo?.full_name ?? null,
    },
    userLogin: data.user?.login ?? null,
  }
}
