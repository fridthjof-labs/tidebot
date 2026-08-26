import type { Octokit } from '@octokit/rest'
import type { RepoRef } from '../types.js'

/**
 * Comments this bot wrote, identified by author rather than by content.
 *
 * Matching a marker alone would let anyone who can comment take control of
 * the bot's own bookkeeping: a comment containing the marker string would be
 * overwritten in place, and — worse — pruned as a duplicate. `issues: write`
 * lets an App edit and delete anyone's comment, so that is a data-loss bug
 * triggerable by any drive-by commenter, not a cosmetic one.
 */
function ownComments<
  T extends { body?: string; user?: { login?: string } | null },
>(comments: T[], marker: string, botLogin: string): T[] {
  return comments.filter(
    (comment) =>
      comment.user?.login === botLogin && comment.body?.includes(marker),
  )
}

export async function upsertIssueCommentWithMarker(
  octokit: Octokit,
  ref: RepoRef,
  issueNumber: number,
  marker: string,
  body: string,
  botLogin: string,
): Promise<void> {
  const { owner, repo } = ref
  const { data: comments } = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
    sort: 'created',
    direction: 'desc',
  })

  const [existing] = ownComments(comments, marker, botLogin)
  if (existing) {
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existing.id,
      body,
    })
  } else {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body,
    })
  }

  await pruneIssueCommentDuplicatesWithMarker(
    octokit,
    ref,
    issueNumber,
    marker,
    botLogin,
  )
}

async function pruneIssueCommentDuplicatesWithMarker(
  octokit: Octokit,
  { owner, repo }: RepoRef,
  issueNumber: number,
  marker: string,
  botLogin: string,
): Promise<void> {
  const { data: comments } = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
    sort: 'created',
    direction: 'desc',
  })

  const duplicates = ownComments(comments, marker, botLogin).slice(1)

  for (const duplicate of duplicates) {
    try {
      await octokit.rest.issues.deleteComment({
        owner,
        repo,
        comment_id: duplicate.id,
      })
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'status' in error &&
        error.status === 404
      ) {
        continue
      }
      throw error
    }
  }
}

export async function commentOnIssue(
  octokit: Octokit,
  { owner, repo }: RepoRef,
  issueNumber: number,
  body: string,
): Promise<void> {
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body,
  })
}

/** Find an issue this bot generated, so a redelivered webhook is idempotent. */
export async function findIssueByBodyMarker(
  octokit: Octokit,
  { owner, repo }: RepoRef,
  marker: string,
  botLogin: string,
): Promise<{ number: number; htmlUrl: string } | null> {
  const { data: issues } = await octokit.rest.issues.listForRepo({
    owner,
    repo,
    state: 'all',
    sort: 'created',
    direction: 'desc',
    per_page: 100,
  })
  const issue = issues.find(
    (candidate) =>
      candidate.user?.login === botLogin && candidate.body?.includes(marker),
  )
  return issue ? { number: issue.number, htmlUrl: issue.html_url } : null
}

export async function createIssue(
  octokit: Octokit,
  { owner, repo }: RepoRef,
  input: { title: string; body: string; labels: string[] },
): Promise<{ number: number; htmlUrl: string }> {
  const { data } = await octokit.rest.issues.create({
    owner,
    repo,
    title: input.title,
    body: input.body,
    labels: input.labels,
  })
  return { number: data.number, htmlUrl: data.html_url }
}

export async function hasIssueCommentMarker(
  octokit: Octokit,
  { owner, repo }: RepoRef,
  issueNumber: number,
  marker: string,
  botLogin: string,
): Promise<boolean> {
  const { data: comments } = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
    sort: 'created',
    direction: 'desc',
  })

  return ownComments(comments, marker, botLogin).length > 0
}
