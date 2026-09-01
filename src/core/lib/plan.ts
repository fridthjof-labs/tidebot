import type { BotConfig } from '../types.js'
import { GLYPH } from './glyphs.js'

const PLAN_BODY_MAX_LENGTH = 60_000

/**
 * Cap what a config-supplied regex is ever run against. The plan body comes
 * from a workflow's job log, so its length is not bounded by anything the bot
 * controls, and `summaryPattern` is written in a repository's config — a
 * pathological pattern over an unbounded string is a hang, not a crash.
 */
const REGEX_INPUT_MAX_LENGTH = 200_000

function bounded(text: string): string {
  return text.length > REGEX_INPUT_MAX_LENGTH
    ? text.slice(0, REGEX_INPUT_MAX_LENGTH)
    : text
}

/**
 * A fence long enough to contain the body. Plan output is attacker-influenced
 * — anyone who can change a workflow's output can put a fence in it — and a
 * three-backtick fence would let that content break out and forge the rest of
 * the bot's comment.
 */
function fenceFor(body: string): string {
  const longestRun = Math.max(
    0,
    ...[...body.matchAll(/`+/g)].map((match) => match[0].length),
  )
  return '`'.repeat(Math.max(3, longestRun + 1))
}

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
  const match = bounded(plan).match(new RegExp(config.summaryPattern, 'i'))
  if (!match) {
    return null
  }
  return match.length === 4
    ? `${match[1]} add, ${match[2]} change, ${match[3]} destroy`
    : match[0]
}

function summaryLine(plan: string, config: BotConfig['plan']): string | null {
  return (
    bounded(plan).match(
      new RegExp(`^.*${config.summaryPattern}.*$`, 'im'),
    )?.[0] ?? null
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
  const fence = fenceFor(truncated)
  lines.push(`${fence}${config.codeFence}`, truncated, fence)

  return lines.join('\n')
}

export function formatApplyComment(
  config: BotConfig['plan'],
  conclusion: string,
  headSha: string,
  branch: string,
): string {
  const icon = conclusion === 'success' ? GLYPH.passed : GLYPH.failed
  return `${icon} ${config.heading} apply **${conclusion}** on \`${branch}\` (\`${headSha.slice(0, 7)}\`).`
}
