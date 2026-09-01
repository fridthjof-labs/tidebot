export type LabelCommandOutcome = {
  kind: 'label'
  label: string
  action: 'applied' | 'removed'
}

export type RetestCommandOutcome = { kind: 'retest' }

export type RebaseCommandOutcome = {
  kind: 'rebase'
  updated: boolean
  message: string
}

export type PlanCommandOutcome = {
  kind: 'plan'
  dispatched: boolean
  message: string
}

export type DeployCommandOutcome = {
  kind: 'deploy'
  dispatched: boolean
  message: string
}

export type UnavailableCommandOutcome = {
  kind: 'unavailable'
  command: string
  message: string
}

export type CommandOutcome =
  | LabelCommandOutcome
  | RetestCommandOutcome
  | RebaseCommandOutcome
  | PlanCommandOutcome
  | DeployCommandOutcome
  | UnavailableCommandOutcome

/**
 * The reply to a comment that ran commands. Label changes produce no text:
 * the label itself is the acknowledgement.
 */
export function formatCommandReply(
  userLogin: string,
  outcomes: CommandOutcome[],
): string {
  const lines: string[] = []

  for (const outcome of outcomes) {
    if (outcome.kind === 'retest') {
      lines.push(
        'Re-run CI from the PR checks tab, or push an empty commit:\n\n```bash\ngit commit --allow-empty -m "retest" && git push\n```',
      )
    }
    if (outcome.kind === 'rebase') {
      const prefix = outcome.updated
        ? 'Updating branch onto base.'
        : 'Branch update failed.'
      lines.push(`@${userLogin} ${prefix} ${outcome.message}`)
    }
    if (outcome.kind === 'plan' || outcome.kind === 'deploy') {
      const noun = outcome.kind === 'plan' ? 'Plan' : 'Deploy'
      const prefix = outcome.dispatched
        ? `${noun} workflow queued.`
        : `${noun} workflow dispatch failed.`
      lines.push(`@${userLogin} ${prefix} ${outcome.message}`)
    }
    if (outcome.kind === 'unavailable') {
      lines.push(`@${userLogin} \`/${outcome.command}\` ${outcome.message}`)
    }
  }

  return lines.join('\n\n')
}
