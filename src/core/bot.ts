import type { Octokit } from '@octokit/rest'
import { loadRepositoryConfigCached } from './config/load.js'
import type { BotContext } from './context.js'
import type { BotClients } from './github.js'
import {
  fetchPullRequest,
  getChecksForRef,
  getPullRequestChangedPaths,
  getRepository,
} from './github.js'
import { type BotIdentity, resolveBotIdentity } from './identity.js'
import { isBotComment } from './lib/commands.js'
import { isDependabotAuthor } from './lib/dependabot.js'
import { maybeRebaseIfBehind } from './lib/tide.js'
import { applyAreaLabels } from './plugins/area-labeler.js'
import { maybeAutoApprove } from './plugins/auto-approve.js'
import {
  handleIssueCommentCommand,
  replyWithCommandHelp,
} from './plugins/commands.js'
import { maybeAutoApproveDependabot } from './plugins/dependabot.js'
import { handleIssueIntake } from './plugins/intake.js'
import {
  handleDeployWorkflowRun,
  maybeRefreshPipelineSummary,
  type WorkflowRunPayload,
} from './plugins/pipeline.js'
import { handlePlanWorkflowRun } from './plugins/plan.js'
import { applySizeLabel } from './plugins/size-labeler.js'
import { applyStaleRules } from './plugins/stale.js'
import { maybeAutoMerge } from './plugins/tide.js'
import type {
  CheckRun,
  CommentContext,
  PullRequest,
  RepoRef,
  Status,
} from './types.js'

export type ContextOptions = {
  /** Skip the extra API call when the webhook payload already told us. */
  defaultBranch?: string
}

/**
 * Build the per-event context: an installation-scoped client, the config that
 * repository resolved to, and this App's own identity. Nothing about which
 * repository the bot serves is baked into the build.
 */
export async function createContext(
  clients: BotClients,
  installationId: number,
  ref: RepoRef,
  options: ContextOptions = {},
): Promise<BotContext> {
  const octokit = await clients.getInstallationOctokit(installationId)
  return buildContext({
    octokit,
    ref,
    identity: await resolveBotIdentity(clients.app),
    defaultBranch: options.defaultBranch,
  })
}

/**
 * Context from an already-authenticated client. The Actions runtime uses this
 * to run without a GitHub App at all, acting as `github-actions[bot]`.
 */
export async function buildContext(input: {
  octokit: Octokit
  ref: RepoRef
  identity: BotIdentity
  defaultBranch?: string
}): Promise<BotContext> {
  const { octokit, ref, identity } = input
  const [config, defaultBranch] = await Promise.all([
    loadRepositoryConfigCached(octokit, ref),
    input.defaultBranch
      ? Promise.resolve(input.defaultBranch)
      : getRepository(octokit, ref).then(
          (repository) => repository.defaultBranch,
        ),
  ])

  return { octokit, ref, config, identity, defaultBranch }
}

function hasMergeIntent(pr: PullRequest, requiredLabels: string[]): boolean {
  return pr.labels.some(
    (label) => label.name != null && requiredLabels.includes(label.name),
  )
}

/**
 * The one path every pull-request-shaped event funnels through. Expensive
 * lookups (changed paths, check runs) are fetched at most once and only when a
 * plugin that is actually enabled needs them.
 */
export async function handlePullRequest(
  ctx: BotContext,
  pullNumber: number,
  pr?: PullRequest,
): Promise<void> {
  const { config } = ctx
  const pull = pr ?? (await fetchPullRequest(ctx.octokit, ctx.ref, pullNumber))

  await applySizeLabel(ctx, pullNumber, pull)
  await applyAreaLabels(ctx, pullNumber)
  await applyStaleRules(ctx, pullNumber, pull)

  const dependabotPull =
    config.plugins.dependabot && isDependabotAuthor(pull.userLogin)
  const autoApproveEnabled =
    config.plugins.autoApprove && config.autoApprove.rules.length > 0
  const needsPaths = dependabotPull || autoApproveEnabled
  const needsChecks =
    needsPaths ||
    config.plugins.tide ||
    (config.plugins.commands &&
      hasMergeIntent(pull, config.tide.requiredLabels))

  let checkRuns: CheckRun[] | undefined
  let statuses: Status[] | undefined
  let changedPaths: string[] | undefined

  if (needsPaths) {
    changedPaths = await getPullRequestChangedPaths(
      ctx.octokit,
      ctx.ref,
      pullNumber,
    )
  }

  if (needsChecks) {
    ;({ checkRuns, statuses } = await getChecksForRef(
      ctx.octokit,
      ctx.ref,
      pull.head.sha,
    ))
  }

  if (checkRuns && statuses && changedPaths) {
    const preloaded = { checkRuns, statuses, changedPaths }
    if (dependabotPull) {
      await maybeAutoApproveDependabot(ctx, pullNumber, pull, preloaded)
    }
    if (autoApproveEnabled) {
      await maybeAutoApprove(ctx, pullNumber, pull, preloaded)
    }
  }

  if (config.plugins.tide && checkRuns && statuses) {
    // A branch update rewrites the head, so skip merging this round and let
    // the resulting check_suite event re-evaluate against the new commit.
    const rebased = await maybeRebaseIfBehind(
      ctx.octokit,
      ctx.ref,
      pullNumber,
      pull,
      config,
      ctx.defaultBranch,
    )
    if (!rebased) {
      await maybeAutoMerge(ctx, pullNumber, pull, { checkRuns, statuses })
    }
  }

  await maybeRefreshPipelineSummary(ctx, pullNumber, pull)
}

export async function handleIssueComment(
  ctx: BotContext,
  comment: CommentContext,
): Promise<void> {
  if (isBotComment(comment.userLogin)) {
    return
  }

  await replyWithCommandHelp(ctx, comment)

  if (await handleIssueCommentCommand(ctx, comment)) {
    await handlePullRequest(ctx, comment.issueNumber)
  }
}

export async function handleIssueIntakeComment(
  ctx: BotContext,
  comment: CommentContext,
): Promise<void> {
  if (isBotComment(comment.userLogin)) {
    return
  }
  await handleIssueIntake(ctx, comment)
}

export async function handleCheckEvent(
  ctx: BotContext,
  pullNumbers: number[],
): Promise<void> {
  for (const pullNumber of new Set(pullNumbers)) {
    await handlePullRequest(ctx, pullNumber)
  }
}

/**
 * One push fans out into two API calls per open pull request, and every
 * installation shares one hourly quota. The cap stops a repository with a
 * large backlog from spending the whole instance's budget on a single push;
 * the ones left out are picked up by their own events.
 */
const MAX_PULLS_PER_PUSH = 50

/** Base branch moved: pull already-approved PRs forward so CI re-runs. */
export async function handleDefaultBranchPush(ctx: BotContext): Promise<void> {
  if (!ctx.config.plugins.tide || !ctx.config.tide.autoRebaseWhenBehind) {
    return
  }

  const { data: pulls } = await ctx.octokit.rest.pulls.list({
    owner: ctx.ref.owner,
    repo: ctx.ref.repo,
    state: 'open',
    base: ctx.defaultBranch,
    per_page: MAX_PULLS_PER_PUSH,
    sort: 'updated',
    direction: 'desc',
  })

  for (const summary of pulls) {
    const pull = await fetchPullRequest(ctx.octokit, ctx.ref, summary.number)
    await maybeRebaseIfBehind(
      ctx.octokit,
      ctx.ref,
      summary.number,
      pull,
      ctx.config,
      ctx.defaultBranch,
    )
  }
}

export async function handleWorkflowRun(
  ctx: BotContext,
  workflowRun: WorkflowRunPayload,
): Promise<void> {
  await handlePlanWorkflowRun(ctx, workflowRun)
  await handleDeployWorkflowRun(ctx, workflowRun)
}

export type { BotContext, Octokit }
