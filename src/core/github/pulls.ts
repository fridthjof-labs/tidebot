import type { Octokit } from '@octokit/rest'
import { hasHttpStatus, httpMessage } from '../lib/http.js'
import type { MergeMethod, PullRequest, RepoRef } from '../types.js'

export async function getRepository(
  octokit: Octokit,
  { owner, repo }: RepoRef,
): Promise<{ defaultBranch: string; private: boolean }> {
  const { data } = await octokit.rest.repos.get({ owner, repo })
  return { defaultBranch: data.default_branch, private: data.private }
}

export async function hasRepositoryWriteAccess(
  octokit: Octokit,
  { owner, repo }: RepoRef,
  username: string,
): Promise<boolean> {
  try {
    const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({
      owner,
      repo,
      username,
    })
    return ['write', 'maintain', 'admin'].includes(data.permission)
  } catch {
    return false
  }
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

/** GitHub returns at most this many files from a comparison. */
const COMPARE_FILE_LIMIT = 300

/**
 * A fingerprint of what a commit proposes against a base: the diff itself,
 * not the commit it lives on.
 *
 * GitHub's compare uses the merge base, so this covers only the branch's own
 * changes. Two revisions with the same fingerprint propose the same code, which
 * is what makes an "update branch" merge or a clean rebase distinguishable from
 * a push that adds new work.
 */
export async function proposedDiffFingerprint(
  octokit: Octokit,
  { owner, repo }: RepoRef,
  base: string,
  head: string,
): Promise<string | null> {
  try {
    const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead: `${base}...${head}`,
    })

    // GitHub caps this response at 300 files. Beyond that the list is a
    // prefix, and two different diffs can share one, so an equal fingerprint
    // would no longer mean equal content.
    const files = data.files ?? []
    if (files.length >= COMPARE_FILE_LIMIT) {
      return null
    }

    return JSON.stringify(
      files.map((file) => [
        file.filename,
        file.status,
        // Binary and oversized files carry no patch; their blob sha still moves
        // when the content does.
        file.patch ?? file.sha,
      ]),
    )
  } catch {
    return null
  }
}

export type PullRequestSummary = {
  number: number
  mergedAt: string | null
  mergeCommitSha: string | null
}

function toSummary(pull: {
  number: number
  merged_at?: string | null
  merge_commit_sha?: string | null
}): PullRequestSummary {
  return {
    number: pull.number,
    mergedAt: pull.merged_at ?? null,
    mergeCommitSha: pull.merge_commit_sha ?? null,
  }
}

/** Open pull requests against a base branch, most recently updated first. */
export async function listOpenPullRequests(
  octokit: Octokit,
  { owner, repo }: RepoRef,
  options: { base?: string; limit?: number } = {},
): Promise<PullRequestSummary[]> {
  const { data } = await octokit.rest.pulls.list({
    owner,
    repo,
    state: 'open',
    base: options.base,
    per_page: options.limit ?? 100,
    sort: 'updated',
    direction: 'desc',
  })
  return data.map(toSummary)
}

/** Recently closed pull requests, for matching a merge commit back to one. */
export async function listRecentlyClosedPullRequests(
  octokit: Octokit,
  { owner, repo }: RepoRef,
  limit = 30,
): Promise<PullRequestSummary[]> {
  const { data } = await octokit.rest.pulls.list({
    owner,
    repo,
    state: 'closed',
    sort: 'updated',
    direction: 'desc',
    per_page: limit,
  })
  return data.map(toSummary)
}

/**
 * A snapshot of every open pull request.
 *
 * Read in full before any caller acts on it. The stale sweep closes pull
 * requests, which removes them from this same filtered set, and paging while
 * that happens shifts later offsets down and skips entries.
 *
 * Mapped per page so only the summaries accumulate: the raw listing carries
 * nested repository, user and branch objects that are an order of magnitude
 * larger and that nothing here reads.
 */
export async function snapshotOpenPullRequests(
  octokit: Octokit,
  { owner, repo }: RepoRef,
): Promise<PullRequestSummary[]> {
  return octokit.paginate(
    octokit.rest.pulls.list,
    { owner, repo, state: 'open', per_page: 100 },
    (response) => response.data.map(toSummary),
  )
}

/**
 * Merge, pinned to the commit whose checks were evaluated. Without `sha` a
 * push landing between that evaluation and this call would merge code nobody
 * reviewed; GitHub answers 409 instead, and the new head's own check_suite
 * event re-runs the gate.
 */
export async function mergePullRequest(
  octokit: Octokit,
  { owner, repo }: RepoRef,
  pullNumber: number,
  mergeMethod: MergeMethod,
  headSha: string,
): Promise<void> {
  await octokit.rest.pulls.merge({
    owner,
    repo,
    pull_number: pullNumber,
    merge_method: mergeMethod,
    sha: headSha,
  })
}

export async function closeIssueAsNotPlanned(
  octokit: Octokit,
  { owner, repo }: RepoRef,
  issueNumber: number,
): Promise<void> {
  await octokit.rest.issues.update({
    owner,
    repo,
    issue_number: issueNumber,
    state: 'closed',
    state_reason: 'not_planned',
  })
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
        hasHttpStatus(error, 422))
        ? 'Cannot update branch — resolve merge conflicts with the base branch first.'
        : error instanceof Error
          ? error.message
          : 'Failed to update branch.'
    return { updated: false, message }
  }
}

/**
 * GitHub answers 422 both for "you already approved this" and for refusals
 * such as approving your own pull request. Only the first is a success, so
 * the message decides — reporting every 422 as approved claimed a review
 * existed when GitHub had refused to create one.
 */
function isAlreadyApprovedError(error: unknown): boolean {
  if (!hasHttpStatus(error, 422)) {
    return false
  }
  const message = httpMessage(error)
  return (
    message.includes('already approved') ||
    message.includes('can only be submitted once') ||
    message.includes('pending review')
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
    if (isAlreadyApprovedError(error)) {
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

/**
 * Compare bodies as GitHub stores them.
 *
 * Bodies submitted through the web form read back with CRLF, so text rendered
 * with LF is byte-different while being the same body. The guard below depends
 * on this comparison being about content rather than encoding.
 */
function sameBody(left: string, right: string): boolean {
  return left.replace(/\r\n/g, '\n') === right.replace(/\r\n/g, '\n')
}

/**
 * Write a rewritten pull request body, but only when it differs from the
 * current one.
 *
 * The no-op guard is required for termination rather than for economy: the
 * write raises `pull_request.edited`, which renders the body again.
 */
export async function updatePullRequestBody(
  octokit: Octokit,
  { owner, repo }: RepoRef,
  pullNumber: number,
  body: string,
  currentBody: string | null | undefined,
): Promise<boolean> {
  if (sameBody(currentBody ?? '', body)) {
    return false
  }

  await octokit.rest.pulls.update({
    owner,
    repo,
    pull_number: pullNumber,
    body,
  })
  return true
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
