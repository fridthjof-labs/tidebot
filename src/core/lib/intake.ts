import type { BotConfig, IntakeCommand, IntakeKind } from '../types.js'
import { intakeMarker } from './markers.js'

const INTAKE_PATTERN = /^\/(bug|feature)(?:\s+([\s\S]+))?$/i
const MAX_TITLE_LENGTH = 100

export function parseIntakeCommand(body: string): IntakeCommand | null {
  const match = body.trim().match(INTAKE_PATTERN)
  const description = match?.[2]?.trim()
  if (!match || !description) {
    return null
  }

  return {
    kind: match[1].toLowerCase() as IntakeKind,
    description,
  }
}

function issueTitle(description: string): string {
  const firstLine = description
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean)
    ?.replace(/^#+\s*/, '')
    .replace(/\s+/g, ' ')

  const title = firstLine || 'Tidebot intake'
  if (title.length <= MAX_TITLE_LENGTH) {
    return title
  }
  return `${title.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`
}

export function buildIntakeIssue(input: {
  command: IntakeCommand
  commentId: number
  requestedBy: string
  sourceUrl: string
  config: BotConfig['intake']
}): { title: string; body: string; labels: string[] } {
  const { command, commentId, requestedBy, sourceUrl, config } = input
  const isBug = command.kind === 'bug'
  const checklist = isBug
    ? [
        'Reproduction steps and impact are confirmed',
        'The affected surface and owner are identified',
        'A regression test or verification plan is defined',
      ]
    : [
        'The user problem and desired outcome are confirmed',
        'Scope and acceptance criteria are defined',
        'Security, accessibility, and operational impact are reviewed',
      ]

  return {
    title: issueTitle(command.description),
    labels: isBug ? config.bugLabels : config.featureLabels,
    body: [
      intakeMarker(commentId),
      `> Generated from [this comment](${sourceUrl}) at the request of @${requestedBy}.`,
      '',
      `## ${isBug ? 'Report' : 'Proposal'}`,
      '',
      command.description,
      '',
      '## Triage checklist',
      '',
      ...checklist.map((item) => `- [ ] ${item}`),
      '',
      '_Generated automatically; requires human triage before implementation._',
    ].join('\n'),
  }
}

export function intakeHelp(): string {
  return [
    'Issue intake:',
    '- `/bug <description>` — create a structured bug report',
    '- `/feature <description>` — create a structured feature request',
    '',
    'Only trusted repository collaborators can generate issues.',
  ].join('\n')
}
