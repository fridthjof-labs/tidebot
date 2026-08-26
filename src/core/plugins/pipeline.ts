import type { BotContext } from '../context.js'
import {
  fetchPullRequest,
  findOpenPullRequestForSha,
  getChecksForRef,
  getDeploymentStatusesForRef,
  upsertIssueCommentWithMarker,
} from '../github.js'
import { PIPELINE_COMMENT_MARKER } from '../lib/markers.js'
import { extractPlanSection, formatPipelineSummary } from '../lib/summary.js'
import { evaluateTide } from '../lib/tide.js'
import type { PullRequest } from '../types.js'

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

  await upsertIssueCommentWithMarker(
    ctx.octokit,
    ctx.ref,
    pullNumber,
    PIPELINE_COMMENT_MARKER,
    formatPipelineSummary({
      checkRuns,
      deployments: deploymentResult.deployments,
      tide: evaluateTide(pr, ctx.config.tide, checkRuns, statuses),
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
}

/** Keep a plan section that an earlier workflow_run wrote into the comment. */
async function readExistingPlanSection(
  ctx: BotContext,
  pullNumber: number,
): Promise<string | null> {
  const listComments = ctx.octokit.rest?.issues?.listComments
  if (!listComments) {
    return null
  }

  const { data: comments } = await listComments({
    owner: ctx.ref.owner,
    repo: ctx.ref.repo,
    issue_number: pullNumber,
    per_page: 100,
    sort: 'created',
    direction: 'desc',
  })
  const existing = comments.find(
    (comment) =>
      comment.user?.login === ctx.identity.login &&
      comment.body?.includes(PIPELINE_COMMENT_MARKER),
  )
  return extractPlanSection(existing?.body ?? null)
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
