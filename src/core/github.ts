import { App } from '@octokit/app'
import { createAppAuth } from '@octokit/auth-app'
import { Octokit } from '@octokit/rest'
import { Webhooks } from '@octokit/webhooks'
import type {
  CheckRun,
  DeploymentStatus,
  PullRequest,
  RepoRef,
  Status,
} from './types.js'

export type BotClients = {
  app: App
  webhooks: Webhooks
  getInstallationOctokit: (installationId: number) => Promise<Octokit>
  getRepositoryInstallationId: (ref: RepoRef) => Promise<number>
  listInstallationRepositories: (installationId: number) => Promise<RepoRef[]>
}

export type BotCredentials = {
  appId: string
  privateKey: string
  webhookSecret?: string
}

/**
 * GitHub still hands out PKCS#1 keys; the Web Crypto implementations behind
 * `@octokit/auth-app` on non-Node runtimes only accept PKCS#8.
 */
async function normalizePrivateKey(pem: string): Promise<string> {
  if (!pem.includes('BEGIN RSA PRIVATE KEY')) {
    return pem
  }

  const { createPrivateKey } = await import('node:crypto')
  return createPrivateKey({ key: pem, format: 'pem', type: 'pkcs1' }).export({
    type: 'pkcs8',
    format: 'pem',
  }) as string
}

export function credentialsFromEnv(
  env: Record<string, string | undefined> = process.env,
): BotCredentials {
  const appId = env.TIDEBOT_APP_ID
  if (!appId) {
    throw new Error('Set TIDEBOT_APP_ID')
  }

  const privateKey = env.TIDEBOT_PRIVATE_KEY
  if (!privateKey) {
    throw new Error('Set TIDEBOT_PRIVATE_KEY')
  }

  return {
    appId,
    privateKey: privateKey.replace(/\\n/g, '\n'),
    webhookSecret: env.TIDEBOT_WEBHOOK_SECRET,
  }
}

export async function createBotClients(
  credentials: BotCredentials,
): Promise<BotClients> {
  const { appId, webhookSecret } = credentials
  const privateKey = await normalizePrivateKey(credentials.privateKey)

  const app = new App(
    webhookSecret
      ? { appId, privateKey, webhooks: { secret: webhookSecret } }
      : { appId, privateKey },
  )
  const webhooks = webhookSecret
    ? new Webhooks({ secret: webhookSecret })
    : null
  const auth = createAppAuth({ appId, privateKey })

  return {
    app,
    // The webhook secret only verifies inbound deliveries. CLI commands
    // authenticate as the App and never receive one, so this is required where
    // it is used rather than at construction.
    get webhooks(): Webhooks {
      if (!webhooks) {
        throw new Error('Set TIDEBOT_WEBHOOK_SECRET to receive webhooks')
      }
      return webhooks
    },
    getInstallationOctokit: async (installationId: number) => {
      const { token } = await auth({ type: 'installation', installationId })
      return new Octokit({ auth: token })
    },
    getRepositoryInstallationId: async ({ owner, repo }: RepoRef) => {
      const { data } = await app.octokit.request(
        'GET /repos/{owner}/{repo}/installation',
        { owner, repo },
      )
      return data.id
    },
    listInstallationRepositories: async (installationId: number) => {
      const { token } = await auth({ type: 'installation', installationId })
      const octokit = new Octokit({ auth: token })
      const refs: RepoRef[] = []
      const iterator = octokit.paginate.iterator(
        octokit.rest.apps.listReposAccessibleToInstallation,
        { per_page: 100 },
      )
      for await (const { data } of iterator) {
        const repositories = Array.isArray(data)
          ? data
          : ((data as { repositories?: unknown[] }).repositories ?? [])
        for (const repository of repositories as Array<{
          name: string
          owner: { login: string }
        }>) {
          refs.push({ owner: repository.owner.login, repo: repository.name })
        }
      }
      return refs
    },
  }
}

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

export async function getChecksForRef(
  octokit: Octokit,
  { owner, repo }: RepoRef,
  ref: string,
): Promise<{ checkRuns: CheckRun[]; statuses: Status[] }> {
  const [{ data: checks }, { data: statuses }] = await Promise.all([
    octokit.rest.checks.listForRef({ owner, repo, ref, per_page: 100 }),
    octokit.rest.repos.listCommitStatusesForRef({
      owner,
      repo,
      ref,
      per_page: 100,
    }),
  ])

  return {
    checkRuns: checks.check_runs.map((run) => ({
      name: run.name,
      conclusion: run.conclusion,
      started_at: run.started_at,
    })),
    statuses: statuses.map((status) => ({
      context: status.context,
      state: status.state,
      created_at: status.created_at,
    })),
  }
}

export async function getDeploymentStatusesForRef(
  octokit: Octokit,
  ref: RepoRef,
  sha: string,
): Promise<{ deployments: DeploymentStatus[]; available: boolean }> {
  try {
    return {
      deployments: await listDeploymentStatusesForRef(octokit, ref, sha),
      available: true,
    }
  } catch {
    return { deployments: [], available: false }
  }
}

async function listDeploymentStatusesForRef(
  octokit: Octokit,
  { owner, repo }: RepoRef,
  ref: string,
): Promise<DeploymentStatus[]> {
  const latestByEnvironment = new Map<
    string,
    { id: number; created_at: string }
  >()
  const iterator = octokit.paginate.iterator(
    octokit.rest.repos.listDeployments,
    { owner, repo, ref, per_page: 100 },
  )

  for await (const { data } of iterator) {
    for (const deployment of data) {
      if (!deployment.environment) {
        continue
      }
      const existing = latestByEnvironment.get(deployment.environment)
      if (!existing || deployment.created_at > existing.created_at) {
        latestByEnvironment.set(deployment.environment, {
          id: deployment.id,
          created_at: deployment.created_at,
        })
      }
    }
  }

  const results: DeploymentStatus[] = []
  for (const [environment, { id }] of latestByEnvironment) {
    const { data: statuses } = await octokit.rest.repos.listDeploymentStatuses({
      owner,
      repo,
      deployment_id: id,
      per_page: 1,
    })
    const latest = statuses[0]
    results.push({
      environment,
      state: latest?.state ?? 'unknown',
      description: latest?.description ?? null,
      url:
        latest?.environment_url ||
        latest?.target_url ||
        latest?.log_url ||
        null,
      updatedAt: latest?.updated_at ?? null,
    })
  }

  return results.sort((left, right) =>
    left.environment.localeCompare(right.environment),
  )
}

export async function upsertIssueCommentWithMarker(
  octokit: Octokit,
  ref: RepoRef,
  issueNumber: number,
  marker: string,
  body: string,
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

  const existing = comments.find((comment) => comment.body?.includes(marker))
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

  await pruneIssueCommentDuplicatesWithMarker(octokit, ref, issueNumber, marker)
}

async function pruneIssueCommentDuplicatesWithMarker(
  octokit: Octokit,
  { owner, repo }: RepoRef,
  issueNumber: number,
  marker: string,
): Promise<void> {
  const { data: comments } = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
    sort: 'created',
    direction: 'desc',
  })

  const duplicates = comments
    .filter((comment) => comment.body?.includes(marker))
    .slice(1)

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

export async function downloadWorkflowJobLogs(
  octokit: Octokit,
  { owner, repo }: RepoRef,
  workflowRunId: number,
  jobName: string,
): Promise<string | null> {
  try {
    const { data: jobs } = await octokit.rest.actions.listJobsForWorkflowRun({
      owner,
      repo,
      run_id: workflowRunId,
      per_page: 100,
    })

    const job = jobs.jobs.find((entry) => entry.name === jobName)
    if (!job) {
      return null
    }

    const response = await octokit.request(
      'GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs',
      { owner, repo, job_id: job.id, request: { redirect: 'manual' } },
    )

    const location =
      typeof response.headers.location === 'string'
        ? response.headers.location
        : null
    if (!location) {
      return null
    }

    const logResponse = await fetch(location)
    return logResponse.ok ? await logResponse.text() : null
  } catch {
    return null
  }
}

export async function dispatchWorkflow(
  octokit: Octokit,
  { owner, repo }: RepoRef,
  workflowFile: string,
  ref: string,
  inputs?: Record<string, string>,
): Promise<{ dispatched: boolean; message: string }> {
  try {
    await octokit.rest.actions.createWorkflowDispatch({
      owner,
      repo,
      workflow_id: workflowFile,
      ref,
      ...(inputs ? { inputs } : {}),
    })
    return {
      dispatched: true,
      message: `Queued \`${workflowFile}\` on \`${ref}\`.`,
    }
  } catch (error) {
    return {
      dispatched: false,
      message: error instanceof Error ? error.message : 'Dispatch failed.',
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

export async function findIssueByBodyMarker(
  octokit: Octokit,
  { owner, repo }: RepoRef,
  marker: string,
): Promise<{ number: number; htmlUrl: string } | null> {
  const { data: issues } = await octokit.rest.issues.listForRepo({
    owner,
    repo,
    state: 'all',
    sort: 'created',
    direction: 'desc',
    per_page: 100,
  })
  const issue = issues.find((candidate) => candidate.body?.includes(marker))
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
): Promise<boolean> {
  const { data: comments } = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
    sort: 'created',
    direction: 'desc',
  })

  return comments.some((comment) => comment.body?.includes(marker))
}

export async function rerunFailedWorkflowsForRef(
  octokit: Octokit,
  { owner, repo }: RepoRef,
  ref: string,
): Promise<{ rerunCount: number }> {
  try {
    const { data } = await octokit.rest.actions.listWorkflowRunsForRepo({
      owner,
      repo,
      head_sha: ref,
      per_page: 30,
    })

    const rerunIds = new Set<number>()
    for (const run of data.workflow_runs) {
      if (run.status !== 'completed') {
        continue
      }
      if (
        run.conclusion !== 'failure' &&
        run.conclusion !== 'cancelled' &&
        run.conclusion !== 'timed_out'
      ) {
        continue
      }
      if (rerunIds.has(run.id)) {
        continue
      }

      await octokit.rest.actions.reRunWorkflowFailedJobs({
        owner,
        repo,
        run_id: run.id,
      })
      rerunIds.add(run.id)
    }

    return { rerunCount: rerunIds.size }
  } catch {
    return { rerunCount: 0 }
  }
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

export async function dismissBotPullRequestApproval(
  octokit: Octokit,
  { owner, repo }: RepoRef,
  pullNumber: number,
  message: string,
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
          review.user?.login?.endsWith('[bot]') && review.state === 'APPROVED',
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
