import type { Octokit } from '@octokit/rest'
import type { RepoRef } from '../types.js'

/** An issue comment or an issue: both carry an author and a body. */
type Authored = {
  body?: string | null
  user?: { login?: string; type?: string } | null
}

/**
 * The comments and issues Tidebot may edit or prune: its own, plus any other
 * bot account's carrying the same marker.
 *
 * The trust boundary is the author's type rather than its login. `issues:
 * write` lets an App edit and delete anyone's comment, so matching on the
 * marker alone would let any commenter have their comment overwritten and
 * pruned. GitHub never reports a human as type `Bot`.
 *
 * Matching other bot accounts is deliberate: a repository running both the App
 * and the in-repo Actions workflow acts under two logins, and the second to
 * run must adopt the first one's comment rather than post its own.
 */
function botAuthoredWithMarker<T extends Authored>(
  items: T[],
  marker: string,
  botLogin: string,
): T[] {
  return items.filter(
    (item) =>
      (item.user?.login === botLogin || item.user?.type === 'Bot') &&
      item.body?.includes(marker),
  )
}

/**
 * Every comment on an issue, oldest first.
 *
 * The full list matters because the status comment is written when the pull
 * request opens: on a long thread it is not in the newest page, and a lookup
 * that misses it posts a second one.
 *
 * Oldest first so a prune keeps the original. The pull request body links to
 * it, and that link has to stay valid.
 */
export type IssueComment = {
  id: number
  body?: string | null
  createdAt: string
  userLogin: string | null
}

/**
 * The most recent comments on an issue, newest first.
 *
 * Bounded to one page on purpose. Callers here are asking what happened
 * lately, and the stale sweep asks it once per open pull request, so walking
 * the full history of a long thread would cost a request per hundred comments
 * for an answer that is always near the top.
 */
export async function listIssueComments(
  octokit: Octokit,
  { owner, repo }: RepoRef,
  issueNumber: number,
): Promise<IssueComment[]> {
  const { data: comments } = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
    sort: 'created',
    direction: 'desc',
  })
  return comments.map((comment) => ({
    id: comment.id,
    body: comment.body,
    createdAt: comment.created_at,
    userLogin: comment.user?.login ?? null,
  }))
}

async function listAllIssueComments(
  octokit: Octokit,
  { owner, repo }: RepoRef,
  issueNumber: number,
): Promise<Array<Authored & { id: number }>> {
  return octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
    sort: 'created',
    direction: 'asc',
  })
}

/**
 * The marked comment the upsert would edit, if it exists.
 *
 * Readers that carry state forward out of that comment must resolve it the
 * same way the upsert does. Two different ownership rules mean the upsert
 * adopts a comment the reader cannot see, and its contents are overwritten.
 */
export async function findManagedIssueComment(
  octokit: Octokit,
  ref: RepoRef,
  issueNumber: number,
  marker: string,
  botLogin: string,
): Promise<string | null> {
  if (!octokit.paginate) {
    return null
  }
  const comments = await listAllIssueComments(octokit, ref, issueNumber)
  return botAuthoredWithMarker(comments, marker, botLogin)[0]?.body ?? null
}

export async function upsertIssueCommentWithMarker(
  octokit: Octokit,
  ref: RepoRef,
  issueNumber: number,
  marker: string,
  body: string,
  botLogin: string,
): Promise<string | null> {
  const { owner, repo } = ref
  const comments = await listAllIssueComments(octokit, ref, issueNumber)

  const managed = botAuthoredWithMarker(comments, marker, botLogin)
  const [existing] = managed
  const written = existing
    ? await octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: existing.id,
        body,
      })
    : await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: issueNumber,
        body,
      })

  // Anything managed beyond the one just written is a duplicate. Computed
  // from the listing above rather than re-reading the thread, which on a long
  // one is a request per hundred comments.
  await deleteComments(octokit, ref, existing ? managed.slice(1) : [])

  return written.data.html_url
}

async function deleteComments(
  octokit: Octokit,
  { owner, repo }: RepoRef,
  duplicates: Array<{ id: number }>,
): Promise<void> {
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
  // Newest page only. The marker names an issue this bot filed for a specific
  // comment, so it is recent; paginating every issue in the repository would
  // cost a request per hundred for an answer that is at the top or absent.
  const { data: issues } = await octokit.rest.issues.listForRepo({
    owner,
    repo,
    state: 'all',
    sort: 'created',
    direction: 'desc',
    per_page: 100,
  })
  const [issue] = botAuthoredWithMarker(issues, marker, botLogin)
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
  ref: RepoRef,
  issueNumber: number,
  marker: string,
  botLogin: string,
): Promise<boolean> {
  const comments = await listAllIssueComments(octokit, ref, issueNumber)
  return botAuthoredWithMarker(comments, marker, botLogin).length > 0
}
