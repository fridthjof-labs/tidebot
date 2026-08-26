import type { Octokit } from '@octokit/rest'
import { dispatchWorkflow, updatePullRequestBranch } from '../github.js'
import type { BotConfig, PullRequest, RepoRef } from '../types.js'

export type BranchUpdateResult = {
  /** True when the branch changed, or a job that will change it was queued. */
  updated: boolean
  message: string
}

/**
 * Bring a pull request branch up to date with its base.
 *
 * `merge` and `rebase` go through GitHub's update-branch API. `signed-rebase`
 * cannot: a real rebase needs `git` and `gpg` on a filesystem, so it is
 * handed to a workflow in the target repository — see docs/signed-rebase.md.
 */
export async function updateBranch(
  octokit: Octokit,
  ref: RepoRef,
  pullNumber: number,
  pr: PullRequest,
  config: BotConfig,
  defaultBranch: string,
): Promise<BranchUpdateResult> {
  const method = config.commands.updateBranchMethod

  if (method !== 'signed-rebase') {
    return updatePullRequestBranch(octokit, ref, pullNumber, method)
  }

  if (isForkPullRequest(pr, ref)) {
    return {
      updated: false,
      message:
        'Signed rebase needs push access to the head branch, which this App does not have on a fork. Update the branch from the fork instead.',
    }
  }

  const result = await dispatchWorkflow(
    octokit,
    ref,
    config.signedRebase.workflowFile,
    config.signedRebase.ref ?? defaultBranch,
    { pull_number: String(pullNumber) },
  )

  if (!result.dispatched) {
    return {
      updated: false,
      message: `Could not start the signed rebase workflow (${config.signedRebase.workflowFile}): ${result.message}`,
    }
  }

  return {
    updated: true,
    message: `Signed rebase queued in \`${config.signedRebase.workflowFile}\`; the branch updates when it finishes.`,
  }
}

export function isForkPullRequest(pr: PullRequest, ref: RepoRef): boolean {
  const headRepo = pr.head.repoFullName
  return Boolean(headRepo) && headRepo !== `${ref.owner}/${ref.repo}`
}
