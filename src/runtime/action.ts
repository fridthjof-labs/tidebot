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
import { resolveBotIdentity } from '../core/identity.js'
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

async function resolveClient(
  env: ActionEnv,
  ref: RepoRef,
): Promise<{ octokit: Octokit; identity: BotIdentity }> {
  // App credentials give the bot its own identity and its own rate limit; the
  // job's GITHUB_TOKEN is the fallback that needs no App registration at all.
  if (env.TIDEBOT_APP_ID && env.TIDEBOT_PRIVATE_KEY) {
    const clients = await createBotClients(
      credentialsFromEnv(env as Record<string, string | undefined>),
    )
    const installationId = await clients.getRepositoryInstallationId(ref)
    return {
      octokit: await clients.getInstallationOctokit(installationId),
      identity: await resolveBotIdentity(clients.app),
    }
  }

  if (!env.GITHUB_TOKEN) {
    throw new Error(
      'Set GITHUB_TOKEN, or TIDEBOT_APP_ID and TIDEBOT_PRIVATE_KEY, for the tidebot action runtime',
    )
  }

  return {
    octokit: new Octokit({ auth: env.GITHUB_TOKEN }),
    identity: ACTIONS_IDENTITY,
  }
}

// The Actions payload is the raw webhook JSON; each handler narrows the part
// it reads rather than restating GitHub's entire event schema here.
// biome-ignore lint/suspicious/noExplicitAny: raw webhook JSON
type EventPayload = Record<string, any>

function commentContext(payload: EventPayload): CommentContext {
  return {
    body: payload.comment.body ?? undefined,
    commentId: payload.comment.id,
    issueNumber: payload.issue.number,
    authorAssociation: payload.comment.author_association ?? null,
    userLogin: payload.comment.user?.login ?? null,
  }
}

async function dispatch(
  ctx: BotContext,
  eventName: string,
  payload: EventPayload,
): Promise<void> {
  switch (eventName) {
    case 'pull_request':
    case 'pull_request_target':
      await handlePullRequest(
        ctx,
        payload.pull_request.number,
        toPullRequest(payload.pull_request),
      )
      return

    case 'issue_comment':
      if (payload.issue.pull_request) {
        await handleIssueComment(ctx, commentContext(payload))
      } else {
        await handleIssueIntakeComment(ctx, commentContext(payload))
      }
      return

    case 'pull_request_review':
      if (payload.action !== 'submitted') {
        return
      }
      await handleIssueComment(ctx, {
        body: payload.review.body ?? undefined,
        commentId: payload.review.id,
        issueNumber: payload.pull_request.number,
        authorAssociation: payload.review.author_association,
        userLogin: payload.review.user?.login ?? null,
      })
      return

    case 'check_suite':
      if (payload.action !== 'completed') {
        return
      }
      await handleCheckEvent(
        ctx,
        (payload.check_suite.pull_requests ?? []).map(
          (pull: { number: number }) => pull.number,
        ),
      )
      return

    case 'workflow_run':
      if (payload.action !== 'completed') {
        return
      }
      await handleWorkflowRun(ctx, {
        id: payload.workflow_run.id,
        name: payload.workflow_run.name ?? null,
        event: payload.workflow_run.event,
        conclusion: payload.workflow_run.conclusion,
        head_sha: payload.workflow_run.head_sha,
        pull_requests: (payload.workflow_run.pull_requests ?? []).map(
          (pull: { number: number }) => ({ number: pull.number }),
        ),
      })
      return

    case 'push':
      if (payload.ref !== `refs/heads/${ctx.defaultBranch}`) {
        return
      }
      await handleDefaultBranchPush(ctx)
      return

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

  const { octokit, identity } = await resolveClient(env, ref)
  const ctx = await buildContext({
    octokit,
    ref,
    identity,
    defaultBranch: payload.repository?.default_branch,
  })

  await dispatch(ctx, eventName, payload)
}
