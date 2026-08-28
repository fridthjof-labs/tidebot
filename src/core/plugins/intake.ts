import type { BotContext } from '../context.js'
import { issueUrl } from '../context.js'
import {
  commentOnIssue,
  createIssue,
  findIssueByBodyMarker,
} from '../github.js'
import {
  buildIntakeIssue,
  intakeHelp,
  parseIntakeCommand,
} from '../lib/intake.js'
import { intakeMarker } from '../lib/markers.js'
import type { CommentContext } from '../types.js'
import { isTrusted } from './commands.js'

/**
 * Turn `/bug` and `/feature` on a plain issue into a structured, labelled
 * issue. The source comment id is embedded as a marker so a redelivered
 * webhook finds the existing issue instead of creating a second one.
 */
export async function handleIssueIntake(
  ctx: BotContext,
  comment: CommentContext,
): Promise<boolean> {
  if (!ctx.config.plugins.intake) {
    return false
  }

  const body = comment.body?.trim() ?? ''
  if (body === '/help') {
    await commentOnIssue(
      ctx.octokit,
      ctx.ref,
      comment.issueNumber,
      intakeHelp(),
    )
    return true
  }

  const command = parseIntakeCommand(body)
  if (!command) {
    return false
  }

  if (!(await isTrusted(ctx, comment))) {
    await commentOnIssue(
      ctx.octokit,
      ctx.ref,
      comment.issueNumber,
      `@${comment.userLogin ?? 'unknown'} must be a repository collaborator to generate an issue.`,
    )
    return true
  }

  if (!comment.commentId) {
    throw new Error('Issue intake requires a comment ID')
  }

  const marker = intakeMarker(comment.commentId)
  const existing = await findIssueByBodyMarker(
    ctx.octokit,
    ctx.ref,
    marker,
    ctx.identity.login,
  )
  const issue =
    existing ??
    (await createIssue(
      ctx.octokit,
      ctx.ref,
      buildIntakeIssue({
        command,
        commentId: comment.commentId,
        requestedBy: comment.userLogin ?? 'unknown',
        sourceUrl: `${issueUrl(ctx.ref, comment.issueNumber)}#issuecomment-${comment.commentId}`,
        config: ctx.config.intake,
      }),
    ))

  await commentOnIssue(
    ctx.octokit,
    ctx.ref,
    comment.issueNumber,
    `${existing ? 'Found existing' : 'Created'} ${command.kind} issue: [#${issue.number}](${issue.htmlUrl}).`,
  )
  return true
}
