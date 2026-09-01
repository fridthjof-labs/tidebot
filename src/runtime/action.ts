import { readFile } from 'node:fs/promises'
import { Octokit } from '@octokit/rest'
import {
  buildContext,
  handleCheckEvent,
  handleDefaultBranchPush,
  handleIssueComment,
  handleIssueIntakeComment,
  handlePullRequest,
  handleWorkflowRun,
} from '../core/bot.js'
import type { BotContext } from '../core/context.js'
import { createBotClients, credentialsFromEnv } from '../core/github.js'
import type { BotIdentity } from '../core/identity.js'
import type { CommentContext, RepoRef } from '../core/types.js'
import { parseRepositoryFullName, toPullRequest } from '../core/webhooks.js'

/**
 * The zero-infrastructure runtime: one workflow in the target repository runs
 * Tidebot against `$GITHUB_EVENT_PATH` on each event. The runner is trusted,
 * so there is no webhook signature to verify here — GitHub already
 * authenticated the delivery by starting the job.
 */
export type ActionEnv = {
  GITHUB_EVENT_NAME?: string
  GITHUB_EVENT_PATH?: string
  GITHUB_REPOSITORY?: string
  GITHUB_TOKEN?: string
  TIDEBOT_APP_ID?: string
  TIDEBOT_PRIVATE_KEY?: string
}

const ACTIONS_IDENTITY: BotIdentity = {
  appId: 0,
  slug: 'github-actions',
  name: 'GitHub Actions',
  login: 'github-actions[bot]',
}

async function resolveClients(
  env: ActionEnv,
  ref: RepoRef,
): Promise<{ octokit: Octokit; branchUpdateOctokit: Octokit }> {
  const hasAppId = Boolean(env.TIDEBOT_APP_ID)
  const hasPrivateKey = Boolean(env.TIDEBOT_PRIVATE_KEY)
  if (hasAppId !== hasPrivateKey) {
    throw new Error(
      'Set both TIDEBOT_APP_ID and TIDEBOT_PRIVATE_KEY, or neither, for the tidebot action runtime',
    )
  }

  if (!env.GITHUB_TOKEN) {
    throw new Error('GITHUB_TOKEN is required for the tidebot action runtime')
  }

  const octokit = new Octokit({ auth: env.GITHUB_TOKEN })
  if (!hasAppId) {
    return { octokit, branchUpdateOctokit: octokit }
  }

  // Actions remains the operator for every visible action. The optional App
  // token is scoped to branch updates because those must re-trigger CI, while
  // pushes made with the workflow's GITHUB_TOKEN are suppressed by GitHub.
  const clients = await createBotClients(
    credentialsFromEnv(env as Record<string, string | undefined>),
  )
  const installationId = await clients.getRepositoryInstallationId(ref)
  return {
    octokit,
    branchUpdateOctokit: await clients.getInstallationOctokit(installationId),
  }
}

/**
 * The event payload as it arrives on disk: unvalidated JSON. Rather than
 * restating GitHub's whole schema, each event names only the fields this
 * runtime reads, and `dispatch` asserts that shape once per case. The webhook
 * runtimes get the same fields from Octokit's own typed emitter.
 */
type EventPayload = { repository?: RepositoryFields; action?: string }

type RepositoryFields = { full_name?: string; default_branch?: string }

type CommentFields = {
  id: number
  body?: string | null
  author_association?: string | null
  user?: { login?: string | null } | null
}

type IssueCommentPayload = EventPayload & {
  issue: { number: number; pull_request?: unknown }
  comment: CommentFields
}

type PullRequestPayload = EventPayload & {
  pull_request: Parameters<typeof toPullRequest>[0] & { number: number }
  /** Present on `synchronize`: the head before and after the push. */
  before?: string
  after?: string
}

type ReviewPayload = EventPayload & {
  pull_request: { number: number }
  review: CommentFields
}

type CheckSuitePayload = EventPayload & {
  check_suite: { pull_requests?: Array<{ number: number }> }
}

type WorkflowRunPayload = EventPayload & {
  workflow_run: {
    id: number
    name?: string | null
    event: string
    conclusion: string | null
    head_sha: string
    pull_requests?: Array<{ number: number }>
  }
}

type PushPayload = EventPayload & { ref: string }

function commentContext(
  issueNumber: number,
  comment: CommentFields,
): CommentContext {
  return {
    body: comment.body ?? undefined,
    commentId: comment.id,
    issueNumber,
    authorAssociation: comment.author_association ?? null,
    userLogin: comment.user?.login ?? null,
  }
}

async function dispatch(
  ctx: BotContext,
  eventName: string,
  payload: EventPayload,
): Promise<void> {
  switch (eventName) {
    case 'pull_request':
    case 'pull_request_target': {
      const event = payload as PullRequestPayload
      await handlePullRequest(
        ctx,
        event.pull_request.number,
        toPullRequest(event.pull_request),
        {
          action: event.action,
          before: event.before ?? null,
          after: event.after ?? null,
        },
      )
      return
    }

    case 'issue_comment': {
      const { issue, comment } = payload as IssueCommentPayload
      const context = commentContext(issue.number, comment)
      if (issue.pull_request) {
        await handleIssueComment(ctx, context)
      } else {
        await handleIssueIntakeComment(ctx, context)
      }
      return
    }

    case 'pull_request_review': {
      if (payload.action !== 'submitted') {
        return
      }
      const { pull_request, review } = payload as ReviewPayload
      await handleIssueComment(ctx, commentContext(pull_request.number, review))
      return
    }

    case 'check_suite': {
      if (payload.action !== 'completed') {
        return
      }
      const { check_suite } = payload as CheckSuitePayload
      await handleCheckEvent(
        ctx,
        (check_suite.pull_requests ?? []).map((pull) => pull.number),
      )
      return
    }

    case 'workflow_run': {
      if (payload.action !== 'completed') {
        return
      }
      const { workflow_run } = payload as WorkflowRunPayload
      await handleWorkflowRun(ctx, {
        id: workflow_run.id,
        name: workflow_run.name ?? null,
        event: workflow_run.event,
        conclusion: workflow_run.conclusion,
        head_sha: workflow_run.head_sha,
        pull_requests: (workflow_run.pull_requests ?? []).map((pull) => ({
          number: pull.number,
        })),
      })
      return
    }

    case 'push': {
      const { ref } = payload as PushPayload
      if (ref !== `refs/heads/${ctx.defaultBranch}`) {
        return
      }
      await handleDefaultBranchPush(ctx)
      return
    }

    default:
      console.log(`tidebot: no handler for event ${eventName}`)
  }
}

export async function runFromActionEnv(
  env: ActionEnv = process.env as ActionEnv,
): Promise<void> {
  const eventName = env.GITHUB_EVENT_NAME
  const eventPath = env.GITHUB_EVENT_PATH
  if (!eventName || !eventPath) {
    throw new Error('GITHUB_EVENT_NAME and GITHUB_EVENT_PATH are required')
  }

  const payload = JSON.parse(await readFile(eventPath, 'utf8')) as EventPayload
  const fullName: string =
    payload.repository?.full_name ?? env.GITHUB_REPOSITORY ?? ''
  const ref = parseRepositoryFullName(fullName)

  const { octokit, branchUpdateOctokit } = await resolveClients(env, ref)
  const ctx = await buildContext({
    octokit,
    branchUpdateOctokit,
    ref,
    identity: ACTIONS_IDENTITY,
    defaultBranch: payload.repository?.default_branch,
  })

  await dispatch(ctx, eventName, payload)
}
