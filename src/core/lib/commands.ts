import type { BotConfig, CommandName, ParsedCommand } from '../types.js'

const COMMAND_PATTERN =
  /\/(?:(lgtm|lgm|approve|hold|unhold|retest|rebase|plan|deploy)|remove-(lgtm|lgm|approve|hold))\b/gi

export function isBotComment(userLogin: string | null | undefined): boolean {
  return userLogin?.endsWith('[bot]') ?? false
}

function normalizeCommandName(name: string): CommandName | null {
  if (name === 'lgm') {
    return 'lgtm'
  }
  if (
    name === 'lgtm' ||
    name === 'approve' ||
    name === 'hold' ||
    name === 'unhold' ||
    name === 'retest' ||
    name === 'rebase' ||
    name === 'plan' ||
    name === 'deploy'
  ) {
    return name
  }
  return null
}

function normalizeRemovedCommandName(name: string): CommandName | null {
  if (name === 'lgm' || name === 'lgtm') {
    return 'remove-lgtm'
  }
  if (name === 'approve') {
    return 'remove-approve'
  }
  if (name === 'hold') {
    return 'unhold'
  }
  return null
}

function parsedCommandFromMatch(
  match: RegExpExecArray,
  cancel: boolean,
): ParsedCommand | null {
  if (match[1]) {
    const name = normalizeCommandName(match[1].toLowerCase())
    if (!name) {
      return null
    }
    return { name, cancel }
  }

  const removed = match[2]?.toLowerCase()
  if (!removed) {
    return null
  }
  const name = normalizeRemovedCommandName(removed)
  if (!name) {
    return null
  }
  return { name, cancel: false }
}

export function parseCommentCommands(body: string): ParsedCommand[] {
  const commands: ParsedCommand[] = []
  const matches = [...body.matchAll(COMMAND_PATTERN)]

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i]
    const start = match.index! + match[0].length
    const end = i + 1 < matches.length ? matches[i + 1].index! : body.length
    const segment = body.slice(start, end)
    const cancel = segment.toLowerCase().includes(' cancel')

    const parsed = parsedCommandFromMatch(match, cancel)
    if (parsed) {
      commands.push(parsed)
    }
  }

  return commands
}

export function parseCommentCommand(body: string): ParsedCommand | null {
  return parseCommentCommands(body)[0] ?? null
}

/** True when the repository has configured the workflow a command needs. */
export function isCommandAvailable(
  name: CommandName,
  config: BotConfig,
): boolean {
  if (name === 'plan') {
    return config.plugins.plan && Boolean(config.plan.workflowFile)
  }
  if (name === 'deploy') {
    return Boolean(config.commands.deployWorkflowFile)
  }
  return true
}

function updateBranchDescription(config: BotConfig): string {
  switch (config.commands.updateBranchMethod) {
    case 'signed-rebase':
      return 'rebase the PR branch onto its base and re-sign the commits'
    case 'rebase':
      return 'rebase the PR branch onto its base'
    default:
      return 'merge the base branch into the PR branch'
  }
}

/**
 * Help text reflects this repository's configuration, so a repo without a
 * plan or deploy workflow is not told about commands that cannot run there.
 */
export function commandHelp(config: BotConfig): string {
  const lines = [
    'Supported commands:',
    '- `/lgtm` or `/lgm` — add the `lgtm` label',
    '- `/lgtm cancel`, `/remove-lgtm`, or `/remove-lgm` — remove `lgtm`',
    '- `/approve` — add the `approved` label and an APPROVE review from this bot',
    '- `/approve cancel` or `/remove-approve` — remove the approval',
    '- `/hold` — block auto-merge',
    '- `/unhold` or `/remove-hold` — allow auto-merge again',
    '- `/retest` — how to re-run CI on this branch',
    `- \`/rebase\` — ${updateBranchDescription(config)}`,
  ]

  if (isCommandAvailable('plan', config)) {
    lines.push(`- \`/plan\` — run ${config.plan.workflowName} on this branch`)
  }
  if (isCommandAvailable('deploy', config)) {
    lines.push('- `/deploy` — deploy previews from this branch')
  }

  lines.push(
    '',
    `Merging needs ${config.tide.requiredLabels.map((label) => `\`${label}\``).join(' + ')} with no ${config.tide.blockedLabels.map((label) => `\`${label}\``).join('/')} label.`,
    'Multiple commands in one comment or review are handled together.',
  )

  return lines.join('\n')
}
