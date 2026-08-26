import type { BotContext } from '../context.js'
import {
  downloadWorkflowJobLogs,
  upsertIssueCommentWithMarker,
} from '../github.js'
import { applyMarker } from '../lib/markers.js'
import {
  formatApplyComment,
  formatPlanSection,
  parsePlanLogFromJobLogs,
} from '../lib/plan.js'
import {
  resolvePullNumbers,
  upsertPipelineSummaryComment,
  type WorkflowRunPayload,
} from './pipeline.js'

/**
 * Turn a plan workflow's job log into a section of the pull request's pipeline
 * comment. The workflow itself does the planning; Tidebot only reports it, so
 * no credentials for the target infrastructure ever reach the bot.
 */
async function postPlanSection(
  ctx: BotContext,
  pullNumber: number,
  workflowRun: WorkflowRunPayload,
): Promise<void> {
  const logs = await downloadWorkflowJobLogs(
    ctx.octokit,
    ctx.ref,
    workflowRun.id,
    ctx.config.plan.planJobName,
  )
  const plan = logs ? parsePlanLogFromJobLogs(logs, ctx.config.plan) : null
  if (!plan) {
    return
  }

  await upsertPipelineSummaryComment(ctx, pullNumber, {
    planSection: formatPlanSection(plan, ctx.config.plan, {
      workflowConclusion: workflowRun.conclusion,
      headSha: workflowRun.head_sha,
    }),
  })
}

/** Report the apply result on the pull request whose merge commit triggered it. */
async function postApplyComment(
  ctx: BotContext,
  workflowRun: WorkflowRunPayload,
): Promise<void> {
  const { data: pulls } = await ctx.octokit.rest.pulls.list({
    owner: ctx.ref.owner,
    repo: ctx.ref.repo,
    state: 'closed',
    sort: 'updated',
    direction: 'desc',
    per_page: 30,
  })

  const merged = pulls.find(
    (pull) => pull.merged_at && pull.merge_commit_sha === workflowRun.head_sha,
  )
  if (!merged) {
    return
  }

  const marker = applyMarker(workflowRun.head_sha)
  await upsertIssueCommentWithMarker(
    ctx.octokit,
    ctx.ref,
    merged.number,
    marker,
    `${formatApplyComment(
      ctx.config.plan,
      workflowRun.conclusion ?? 'unknown',
      workflowRun.head_sha,
      ctx.defaultBranch,
    )}\n\n${marker}`,
    ctx.identity.login,
  )
}

export async function handlePlanWorkflowRun(
  ctx: BotContext,
  workflowRun: WorkflowRunPayload,
): Promise<void> {
  if (!ctx.config.plugins.plan) {
    return
  }
  if (workflowRun.name !== ctx.config.plan.workflowName) {
    return
  }

  if (workflowRun.event === 'push') {
    if (workflowRun.conclusion) {
      await postApplyComment(ctx, workflowRun)
    }
    return
  }

  if (
    workflowRun.event !== 'pull_request' &&
    workflowRun.event !== 'workflow_dispatch'
  ) {
    return
  }

  for (const pullNumber of await resolvePullNumbers(ctx, workflowRun)) {
    await postPlanSection(ctx, pullNumber, workflowRun)
  }
}
