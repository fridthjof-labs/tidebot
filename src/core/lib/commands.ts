import type { BotConfig, CommandName, ParsedCommand } from '../types.js'

/**
 * A command must be the first thing on its line, as in Prow. Matching
 * anywhere in the body would mean that quoting a comment, pasting the help
 * text, or writing "don't /approve this yet" runs the command — and `/help`
 * itself lists every command, so a body that mentions one is common.
 */
const COMMAND_LINE_PATTERN =
  /^\/(?:(lgtm|lgm|approve|hold|unhold|retest|rebase|plan|deploy)|remove-(lgtm|lgm|approve|hold))\b(.*)$/i

const CODE_FENCE_PATTERN = /^\s*(```|~~~)/

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

/** Lines a command may appear on: not fenced, not quoted from elsewhere. */
function commandLines(body: string): string[] {
  const lines: string[] = []
  let inFence = false

  for (const raw of body.split('\n')) {
    if (CODE_FENCE_PATTERN.test(raw)) {
      inFence = !inFence
      continue
    }
    if (inFence) {
      continue
    }

    const line = raw.trim()
    if (line.startsWith('>')) {
      continue
    }
    lines.push(line)
  }

  return lines
}

export function parseCommentCommands(body: string): ParsedCommand[] {
  const commands: ParsedCommand[] = []

  for (const line of commandLines(body)) {
    const match = line.match(COMMAND_LINE_PATTERN)
    if (!match) {
      continue
    }

    const cancel = /^\s*cancel\b/i.test(match[3] ?? '')

    if (match[1]) {
      const name = normalizeCommandName(match[1].toLowerCase())
      if (name) {
        commands.push({ name, cancel })
      }
      continue
    }

    const removed = match[2]?.toLowerCase()
    const name = removed ? normalizeRemovedCommandName(removed) : null
    if (name) {
      commands.push({ name, cancel: false })
    }
  }

  return commands
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
