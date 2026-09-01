import type { EmitterWebhookEventName } from '@octokit/webhooks'
import {
  createContext,
  handleCheckEvent,
  handleDefaultBranchPush,
  handleIssueComment,
  handleIssueIntakeComment,
  handlePullRequest,
  handleWorkflowRun,
} from './bot.js'
import { invalidateConfigCache, touchesConfig } from './config/load.js'
import type { BotClients } from './github.js'
import type { CommentContext, PullRequest, RepoRef } from './types.js'

export type WebhookOptions = {
  /**
   * Optional second gate in front of the App installation itself. Installing
   * the App is normally the only allowlist that matters; this exists for a
   * shared instance that must refuse an installation added by mistake.
   */
  allowedOwners?: string[]
}

export function parseRepositoryFullName(fullName: string): RepoRef {
  const [owner, repo] = fullName.split('/')
  if (!owner || !repo) {
    throw new Error(`Invalid repository "${fullName}"`)
  }
  return { owner, repo }
}

function isAllowed(ref: RepoRef, options: WebhookOptions): boolean {
  const allowed = options.allowedOwners
  if (!allowed || allowed.length === 0) {
    return true
  }
  return allowed.some(
    (owner) => owner.toLowerCase() === ref.owner.toLowerCase(),
  )
}

type RepositoryPayload = {
  repository: { full_name: string; default_branch?: string }
  installation?: { id?: number } | null
}

/** Everything an event needs before any plugin runs, or null to ignore it. */
function eventTarget(
  payload: RepositoryPayload,
  options: WebhookOptions,
): { ref: RepoRef; installationId: number; defaultBranch?: string } | null {
  const installationId = payload.installation?.id
  if (typeof installationId !== 'number') {
    return null
  }

  const ref = parseRepositoryFullName(payload.repository.full_name)
  if (!isAllowed(ref, options)) {
    return null
  }

  return {
    ref,
    installationId,
    defaultBranch: payload.repository.default_branch,
  }
}

export function toPullRequest(payload: {
  node_id: string
  draft?: boolean | null
  state: string
  merged?: boolean | null
  merged_at?: string | null
  title?: string | null
  body?: string | null
  mergeable?: boolean | null
  mergeable_state?: string | null
  labels: Array<{ name?: string | null }>
  additions?: number
  deletions?: number
  updated_at?: string | null
  base?: { ref?: string | null } | null
  head: {
    sha: string
    ref?: string | null
    repo?: { full_name?: string } | null
  }
  user?: { login?: string | null } | null
}): PullRequest {
  return {
    id: payload.node_id,
    draft: payload.draft ?? false,
    state: payload.state,
    merged: payload.merged ?? Boolean(payload.merged_at),
    title: payload.title ?? null,
    body: payload.body ?? null,
    mergeable: payload.mergeable ?? null,
    mergeable_state: payload.mergeable_state ?? null,
    labels: payload.labels,
    additions: payload.additions ?? 0,
    deletions: payload.deletions ?? 0,
    updated_at: payload.updated_at,
    base: { ref: payload.base?.ref ?? null },
    head: {
      sha: payload.head.sha,
      ref: payload.head.ref ?? null,
      repoFullName: payload.head.repo?.full_name ?? null,
    },
    userLogin: payload.user?.login ?? null,
  }
}

export function registerWebhookHandlers(
  clients: BotClients,
  options: WebhookOptions = {},
): void {
  const { webhooks } = clients

  webhooks.onError((error) => {
    const event = error.event as { name?: string; id?: string } | undefined
    console.error(
      JSON.stringify({
        message: 'github webhook handler error',
        event: event?.name ?? 'unknown',
        delivery: event?.id ?? 'unknown',
        error: error.message,
      }),
    )
  })

  webhooks.on('pull_request', async ({ payload }) => {
    const target = eventTarget(payload, options)
    if (!target) {
      return
    }
    const ctx = await createContext(
      clients,
      target.installationId,
      target.ref,
      {
        defaultBranch: target.defaultBranch,
      },
    )
    await handlePullRequest(
      ctx,
      payload.pull_request.number,
      toPullRequest(payload.pull_request),
      {
        action: payload.action,
        before: 'before' in payload ? payload.before : null,
        after: 'after' in payload ? payload.after : null,
      },
    )
  })

  webhooks.on('issue_comment', async ({ payload }) => {
    const target = eventTarget(payload, options)
    if (!target) {
      return
    }
    const ctx = await createContext(
      clients,
      target.installationId,
      target.ref,
      {
        defaultBranch: target.defaultBranch,
      },
    )
    const comment: CommentContext = {
      body: payload.comment.body ?? undefined,
      commentId: payload.comment.id,
      issueNumber: payload.issue.number,
      authorAssociation: payload.comment.author_association,
      userLogin: payload.comment.user?.login ?? null,
    }
    if (payload.issue.pull_request) {
      await handleIssueComment(ctx, comment)
    } else {
      await handleIssueIntakeComment(ctx, comment)
    }
  })

  webhooks.on('pull_request_review', async ({ payload }) => {
    const target = eventTarget(payload, options)
    if (!target || payload.action !== 'submitted') {
      return
    }
    const ctx = await createContext(
      clients,
      target.installationId,
      target.ref,
      {
        defaultBranch: target.defaultBranch,
      },
    )
    await handleIssueComment(ctx, {
      body: payload.review.body ?? undefined,
      commentId: payload.review.id,
      issueNumber: payload.pull_request.number,
      authorAssociation: payload.review.author_association,
      userLogin: payload.review.user?.login ?? null,
    })
  })

  webhooks.on('push', async ({ payload }) => {
    const target = eventTarget(payload, options)
    if (!target) {
      return
    }

    const defaultBranch = payload.repository.default_branch
    if (payload.ref !== `refs/heads/${defaultBranch}`) {
      return
    }

    // A merged config change must take effect now, not up to a TTL later.
    const changedPaths = payload.commits.flatMap((commit) => [
      ...(commit.added ?? []),
      ...(commit.modified ?? []),
      ...(commit.removed ?? []),
    ])
    if (touchesConfig(changedPaths)) {
      invalidateConfigCache(target.ref)
    }

    const ctx = await createContext(
      clients,
      target.installationId,
      target.ref,
      {
        defaultBranch,
      },
    )
    await handleDefaultBranchPush(ctx)
  })

  webhooks.on('check_suite', async ({ payload }) => {
    const target = eventTarget(payload, options)
    if (!target || payload.action !== 'completed') {
      return
    }
    if (payload.check_suite.pull_requests.length === 0) {
      return
    }
    const ctx = await createContext(
      clients,
      target.installationId,
      target.ref,
      {
        defaultBranch: target.defaultBranch,
      },
    )
    await handleCheckEvent(
      ctx,
      payload.check_suite.pull_requests.map((pull) => pull.number),
    )
  })

  webhooks.on('workflow_run', async ({ payload }) => {
    const target = eventTarget(payload, options)
    if (!target || payload.action !== 'completed') {
      return
    }
    const ctx = await createContext(
      clients,
      target.installationId,
      target.ref,
      {
        defaultBranch: target.defaultBranch,
      },
    )
    await handleWorkflowRun(ctx, {
      id: payload.workflow_run.id,
      name: payload.workflow_run.name ?? null,
      event: payload.workflow_run.event,
      conclusion: payload.workflow_run.conclusion,
      head_sha: payload.workflow_run.head_sha,
      pull_requests: payload.workflow_run.pull_requests
        ?.filter((pull): pull is NonNullable<typeof pull> => pull != null)
        .map((pull) => ({ number: pull.number })),
    })
  })
}

export type GithubWebhookHeaders = {
  deliveryId: string
  eventName: string
  signature: string
}

export const MAX_WEBHOOK_BODY_BYTES = 2 * 1024 * 1024

export class GithubWebhookSignatureError extends Error {}

export async function verifyGithubWebhookSignature(
  clients: BotClients,
  body: string,
  signature: string,
): Promise<void> {
  if (!(await clients.webhooks.verify(body, signature))) {
    throw new GithubWebhookSignatureError('Invalid GitHub webhook signature')
  }
}

export async function verifyGithubWebhook(
  clients: BotClients,
  body: string,
  headers: GithubWebhookHeaders,
): Promise<void> {
  await clients.webhooks.verifyAndReceive({
    id: headers.deliveryId,
    // The header is an arbitrary string until the signature is verified.
    // Octokit rejects a name it does not know, so this asserts the shape
    // rather than the value.
    name: headers.eventName as EmitterWebhookEventName,
    signature: headers.signature,
    payload: body,
  })
}
