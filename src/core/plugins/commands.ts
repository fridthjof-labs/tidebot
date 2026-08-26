import type { BotContext } from '../context.js'
import {
  commentOnIssue,
  dismissBotPullRequestApproval,
  dispatchWorkflow,
  fetchPullRequest,
  getPullRequestLabels,
  submitPullRequestApproval,
} from '../github.js'
import {
  commandHelp,
  isBotComment,
  isCommandAvailable,
  parseCommentCommands,
} from '../lib/commands.js'
import { setWorkflowLabel } from '../lib/labels.js'
import { updateBranch } from '../lib/rebase.js'
import type { CommandOutcome } from '../lib/summary.js'
import { formatCommandReply } from '../lib/summary.js'
import type { CommentContext, ParsedCommand } from '../types.js'
import { upsertPipelineSummaryComment } from './pipeline.js'

function labelForCommand(
  ctx: BotContext,
  command: ParsedCommand,
): { label: string; enabled: boolean } | null {
  const [lgtmLabel, approvedLabel] = ctx.config.tide.requiredLabels
  const holdLabel = ctx.config.tide.blockedLabels[0] ?? 'hold'

  switch (command.name) {
    case 'lgtm':
      return { label: lgtmLabel ?? 'lgtm', enabled: !command.cancel }
    case 'remove-lgtm':
      return { label: lgtmLabel ?? 'lgtm', enabled: false }
    case 'approve':
      return { label: approvedLabel ?? 'approved', enabled: !command.cancel }
    case 'remove-approve':
      return { label: approvedLabel ?? 'approved', enabled: false }
    case 'hold':
      return { label: holdLabel, enabled: !command.cancel }
    case 'unhold':
      return { label: holdLabel, enabled: false }
    case 'retest':
    case 'rebase':
    case 'plan':
    case 'deploy':
      return null
    default: {
      const never: never = command.name
      throw new Error(`Unhandled command ${never}`)
    }
  }
}

function isApprovalLabel(ctx: BotContext, label: string): boolean {
  return label === (ctx.config.tide.requiredLabels[1] ?? 'approved')
}

async function executeCommentCommand(
  ctx: BotContext,
  comment: CommentContext,
  command: ParsedCommand,
): Promise<CommandOutcome | null> {
  if (!isCommandAvailable(command.name, ctx.config)) {
    return {
      kind: 'unavailable',
      command: command.name,
      message: 'is not configured for this repository.',
    }
  }

  if (command.name === 'retest') {
    return { kind: 'retest' }
  }

  if (command.name === 'rebase') {
    const pull = await fetchPullRequest(
      ctx.octokit,
      ctx.ref,
      comment.issueNumber,
    )
    const result = await updateBranch(
      ctx.octokit,
      ctx.ref,
      comment.issueNumber,
      pull,
      ctx.config,
      ctx.defaultBranch,
    )
    return { kind: 'rebase', updated: result.updated, message: result.message }
  }

  if (command.name === 'plan' || command.name === 'deploy') {
    const pull = await fetchPullRequest(
      ctx.octokit,
      ctx.ref,
      comment.issueNumber,
    )
    const ref = pull.head.ref ?? pull.head.sha
    const workflowFile =
      command.name === 'plan'
        ? ctx.config.plan.workflowFile
        : ctx.config.commands.deployWorkflowFile
    const result = await dispatchWorkflow(
      ctx.octokit,
      ctx.ref,
      workflowFile!,
      ref,
      command.name === 'deploy' ? ctx.config.commands.deployInputs : undefined,
    )
    return {
      kind: command.name,
      dispatched: result.dispatched,
      message: result.message,
    }
  }

  const mapping = labelForCommand(ctx, command)
  if (!mapping) {
    return null
  }

  // GitHub refuses self-approval, so `/approve` from a PR author is proxied as
  // a review from the App with the requester named in the body.
  if (isApprovalLabel(ctx, mapping.label)) {
    const userLogin = comment.userLogin ?? 'unknown'
    if (mapping.enabled) {
      const pull = await fetchPullRequest(
        ctx.octokit,
        ctx.ref,
        comment.issueNumber,
      )
      await submitPullRequestApproval(
        ctx.octokit,
        ctx.ref,
        comment.issueNumber,
        pull.head.sha,
        `Approved on behalf of @${userLogin} via \`/approve\`.`,
      )
    } else {
      await dismissBotPullRequestApproval(
        ctx.octokit,
        ctx.ref,
        comment.issueNumber,
        `Approval withdrawn by @${userLogin}.`,
      )
    }
  }

  const currentLabels = await getPullRequestLabels(
    ctx.octokit,
    ctx.ref,
    comment.issueNumber,
  )
  await setWorkflowLabel(
    ctx.octokit,
    ctx.ref,
    comment.issueNumber,
    currentLabels,
    mapping.label,
    mapping.enabled,
  )

  return {
    kind: 'label',
    label: mapping.label,
    action: mapping.enabled ? 'applied' : 'removed',
  }
}

export async function replyWithCommandHelp(
  ctx: BotContext,
  issueNumber: number,
  body: string,
): Promise<void> {
  if (body.trim() !== '/help') {
    return
  }
  await commentOnIssue(
    ctx.octokit,
    ctx.ref,
    issueNumber,
    commandHelp(ctx.config),
  )
}

/**
 * Run every command in one comment or review body, then refresh the single
 * pipeline comment once. Label changes stay silent — the label is the signal.
 */
export async function handleIssueCommentCommand(
  ctx: BotContext,
  comment: CommentContext,
): Promise<boolean> {
  if (!ctx.config.plugins.commands || isBotComment(comment.userLogin)) {
    return false
  }

  const commands = parseCommentCommands(comment.body ?? '')
  if (commands.length === 0) {
    return false
  }

  if (
    !ctx.config.commands.trustedAssociations.includes(
      comment.authorAssociation ?? 'NONE',
    )
  ) {
    await commentOnIssue(
      ctx.octokit,
      ctx.ref,
      comment.issueNumber,
      `@${comment.userLogin ?? 'unknown'} must be a repository collaborator to run commands.`,
    )
    return false
  }

  const outcomes: CommandOutcome[] = []
  for (const command of commands) {
    const outcome = await executeCommentCommand(ctx, comment, command)
    if (outcome) {
      outcomes.push(outcome)
    }
  }

  const reply = formatCommandReply(comment.userLogin ?? 'unknown', outcomes)
  if (reply.trim().length > 0) {
    await commentOnIssue(ctx.octokit, ctx.ref, comment.issueNumber, reply)
  }

  if (outcomes.length > 0) {
    await upsertPipelineSummaryComment(ctx, comment.issueNumber)
  }

  return outcomes.length > 0
}
