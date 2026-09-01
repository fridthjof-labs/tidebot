import type { Octokit } from '@octokit/rest'
import type { RepoRef } from '../types.js'

/** Buffer is unavailable in the Workers runtime; atob is in both. */
function decodeBase64(content: string): string {
  return typeof Buffer !== 'undefined'
    ? Buffer.from(content, 'base64').toString('utf8')
    : new TextDecoder().decode(
        Uint8Array.from(atob(content.replace(/\n/g, '')), (character) =>
          character.charCodeAt(0),
        ),
      )
}

/**
 * A repository file's decoded text, or null when the path is not a file.
 *
 * The contents API answers with a directory listing, a symlink or a submodule
 * for the same path shape, so a caller that wants a file gets a file or
 * nothing. Errors are the caller's to interpret: a 404 means "no such file",
 * which is a valid state for config and a real failure elsewhere.
 */
export async function getFileText(
  octokit: Octokit,
  { owner, repo }: RepoRef,
  path: string,
): Promise<string | null> {
  const { data } = await octokit.rest.repos.getContent({ owner, repo, path })
  if (Array.isArray(data) || data.type !== 'file' || !('content' in data)) {
    return null
  }
  return decodeBase64(data.content)
}

/** File names directly under a repository directory; empty when unreadable. */
export async function listDirectoryFileNames(
  octokit: Octokit,
  { owner, repo }: RepoRef,
  path: string,
): Promise<string[]> {
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path })
    return Array.isArray(data) ? data.map((entry) => entry.name) : []
  } catch {
    return []
  }
}

/** When a commit was made, preferring the committer's date over the author's. */
export async function getCommitDate(
  octokit: Octokit,
  { owner, repo }: RepoRef,
  commitSha: string,
): Promise<string | null> {
  try {
    const { data } = await octokit.rest.git.getCommit({
      owner,
      repo,
      commit_sha: commitSha,
    })
    return data.committer?.date ?? data.author?.date ?? null
  } catch {
    return null
  }
}
