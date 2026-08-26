import type { BotConfig } from '../types.js'

const PLAN_BODY_MAX_LENGTH = 60_000

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '').replace(/\^\[\[[0-9;]*m/g, '')
}

function stripGithubActionLogPrefixes(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.-]+Z /, ''))
    .join('\n')
}

/**
 * Pull the plan body out of a job log. The workflow brackets its plan output
 * with the configured markers; anything outside them is runner noise.
 */
export function parsePlanLogFromJobLogs(
  logs: string,
  config: BotConfig['plan'],
): string | null {
  const normalized = stripAnsi(logs)
  const end = normalized.lastIndexOf(config.logEndMarker)
  if (end === -1) {
    return null
  }

  const begin = normalized.lastIndexOf(config.logBeginMarker, end)
  if (begin === -1 || end <= begin) {
    return null
  }

  const cleaned = stripGithubActionLogPrefixes(
    normalized.slice(begin + config.logBeginMarker.length, end),
  )
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => {
      const trimmed = line.trim()
      return (
        trimmed.length > 0 &&
        trimmed !== config.logBeginMarker &&
        trimmed !== config.logEndMarker
      )
    })
    .join('\n')
    .trim()

  return cleaned || null
}

export function parsePlanChangeSummary(
  plan: string,
  config: BotConfig['plan'],
): string | null {
  const match = plan.match(new RegExp(config.summaryPattern, 'i'))
  if (!match) {
    return null
  }
  return match.length === 4
    ? `${match[1]} add, ${match[2]} change, ${match[3]} destroy`
    : match[0]
}

function summaryLine(plan: string, config: BotConfig['plan']): string | null {
  return (
    plan.match(new RegExp(`^.*${config.summaryPattern}.*$`, 'im'))?.[0] ?? null
  )
}

function trimPlanFooter(text: string, config: BotConfig['plan']): string {
  const line = summaryLine(text, config)
  if (!line) {
    return text.trim()
  }
  return text.slice(0, text.indexOf(line) + line.length).trim()
}

/** Drop provider setup and refresh chatter, keeping the actions and summary. */
export function trimPlanLogForComment(
  plan: string,
  config: BotConfig['plan'],
): string {
  const actionsIndex = plan.indexOf(config.actionsMarker)
  if (actionsIndex !== -1) {
    const lineStart = plan.lastIndexOf('\n', actionsIndex) + 1
    return trimPlanFooter(plan.slice(lineStart), config)
  }

  const noChangesIndex = plan.indexOf(config.noChangesMarker)
  if (noChangesIndex !== -1) {
    const rest = plan.slice(noChangesIndex)
    const paragraphEnd = rest.indexOf('\n\n')
    return (paragraphEnd === -1 ? rest : rest.slice(0, paragraphEnd)).trim()
  }

  return summaryLine(plan, config) ?? plan
}

export function formatPlanSection(
  plan: string,
  config: BotConfig['plan'],
  options?: { workflowConclusion?: string | null; headSha?: string },
): string {
  const trimmed = trimPlanLogForComment(plan, config)
  const truncated =
    trimmed.length > PLAN_BODY_MAX_LENGTH
      ? `${trimmed.slice(0, PLAN_BODY_MAX_LENGTH)}\n\n... truncated ...`
      : trimmed
  const summary =
    parsePlanChangeSummary(trimmed, config) ??
    parsePlanChangeSummary(plan, config)
  const lines: string[] = []

  if (options?.workflowConclusion && options.workflowConclusion !== 'success') {
    lines.push(`**Workflow:** ${options.workflowConclusion}`, '')
  }
  if (summary) {
    lines.push(`**Summary:** ${summary}`, '')
  }
  if (options?.headSha) {
    lines.push(`Commit: \`${options.headSha.slice(0, 7)}\``, '')
  }
  lines.push(`\`\`\`${config.codeFence}`, truncated, '```')

  return lines.join('\n')
}

export function formatApplyComment(
  config: BotConfig['plan'],
  conclusion: string,
  headSha: string,
  branch: string,
): string {
  const icon = conclusion === 'success' ? '✅' : '❌'
  return `${icon} ${config.heading} apply **${conclusion}** on \`${branch}\` (\`${headSha.slice(0, 7)}\`).`
}
