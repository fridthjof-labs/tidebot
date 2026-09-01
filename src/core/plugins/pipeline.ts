import type { BotContext } from '../context.js'
import {
  fetchPullRequest,
  findManagedIssueComment,
  findOpenPullRequestForSha,
  getChecksForRef,
  getDeploymentStatusesForRef,
  updatePullRequestBody,
  upsertIssueCommentWithMarker,
} from '../github.js'
import { PIPELINE_COMMENT_MARKER } from '../lib/markers.js'
import {
  extractPlanSection,
  formatPipelineSummary,
  formatStatusBlock,
  upsertStatusBlock,
} from '../lib/summary.js'
import { evaluateTide } from '../lib/tide.js'
import type { CheckRun, PullRequest, TideDecision } from '../types.js'

export type WorkflowRunPayload = {
  id: number
  name: string | null
  event: string
  conclusion: string | null
  head_sha: string
  pull_requests?: Array<{ number: number }>
}

export async function upsertPipelineSummaryComment(
  ctx: BotContext,
  pullNumber: number,
  options?: { planSection?: string | null },
): Promise<void> {
  if (!ctx.config.plugins.commands) {
    return
  }

  const pr = await fetchPullRequest(ctx.octokit, ctx.ref, pullNumber)
  const [{ checkRuns, statuses }, deploymentResult] = await Promise.all([
    getChecksForRef(ctx.octokit, ctx.ref, pr.head.sha),
    ctx.config.plugins.pipeline
      ? getDeploymentStatusesForRef(ctx.octokit, ctx.ref, pr.head.sha)
      : Promise.resolve({ deployments: [], available: true }),
  ])

  const tide = evaluateTide(pr, ctx.config.tide, checkRuns, statuses)

  const commentUrl = await upsertIssueCommentWithMarker(
    ctx.octokit,
    ctx.ref,
    pullNumber,
    PIPELINE_COMMENT_MARKER,
    formatPipelineSummary({
      checkRuns,
      deployments: deploymentResult.deployments,
      tide,
      pr,
      config: ctx.config,
      deploymentsAvailable: deploymentResult.available,
      planSection:
        options?.planSection !== undefined
          ? options.planSection
          : await readExistingPlanSection(ctx, pullNumber),
    }),
    ctx.identity.login,
  )

  await syncStatusBlock(ctx, pullNumber, pr, checkRuns, tide, commentUrl)
}

/**
 * Mirror the verdict into the pull request body. The comment holds the detail
 * but sits wherever the timeline put it, which on a busy pull request is far
 * above the fold.
 */
async function syncStatusBlock(
  ctx: BotContext,
  pullNumber: number,
  pr: PullRequest,
  checkRuns: CheckRun[],
  tide: TideDecision,
  commentUrl: string | null,
): Promise<void> {
  if (!ctx.config.pipeline.statusInBody) {
    return
  }

  const body = upsertStatusBlock(
    pr.body,
    formatStatusBlock({
      checkRuns,
      tide,
      pr,
      config: ctx.config,
      commentUrl,
    }),
  )

  await updatePullRequestBody(ctx.octokit, ctx.ref, pullNumber, body, pr.body)
}

/** Keep a plan section that an earlier workflow_run wrote into the comment. */
async function readExistingPlanSection(
  ctx: BotContext,
  pullNumber: number,
): Promise<string | null> {
  return extractPlanSection(
    await findManagedIssueComment(
      ctx.octokit,
      ctx.ref,
      pullNumber,
      PIPELINE_COMMENT_MARKER,
      ctx.identity.login,
    ),
  )
}

export async function maybeRefreshPipelineSummary(
  ctx: BotContext,
  pullNumber: number,
  pr: PullRequest,
): Promise<void> {
  if (pr.draft || pr.state !== 'open') {
    return
  }

  await upsertPipelineSummaryComment(ctx, pullNumber)
}

export async function resolvePullNumbers(
  ctx: BotContext,
  workflowRun: Pick<WorkflowRunPayload, 'head_sha' | 'pull_requests'>,
): Promise<number[]> {
  const fromPayload =
    workflowRun.pull_requests?.map((pull) => pull.number) ?? []
  if (fromPayload.length > 0) {
    return fromPayload
  }

  const pullNumber = await findOpenPullRequestForSha(
    ctx.octokit,
    ctx.ref,
    workflowRun.head_sha,
  )
  return pullNumber ? [pullNumber] : []
}

/** Refresh the summary once the configured deploy workflow reports back. */
export async function handleDeployWorkflowRun(
  ctx: BotContext,
  workflowRun: WorkflowRunPayload,
): Promise<void> {
  const deployWorkflowName = ctx.config.pipeline.deployWorkflowName
  if (!ctx.config.plugins.pipeline || !deployWorkflowName) {
    return
  }
  if (workflowRun.name !== deployWorkflowName || !workflowRun.conclusion) {
    return
  }

  for (const pullNumber of await resolvePullNumbers(ctx, workflowRun)) {
    const pr = await fetchPullRequest(ctx.octokit, ctx.ref, pullNumber)
    if (pr.draft || pr.state !== 'open') {
      continue
    }
    await upsertPipelineSummaryComment(ctx, pullNumber)
  }
}
