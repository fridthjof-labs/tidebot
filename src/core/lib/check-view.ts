import type { CheckRun } from '../types.js'
import { latestCheckRunsByName } from './checks.js'
import { GLYPH } from './glyphs.js'

/** Conclusions that mean a check reported and lost, rather than was skipped. */
const ATTENTION_CHECK_CONCLUSIONS = new Set([
  'failure',
  'error',
  'cancelled',
  'timed_out',
  'action_required',
])

/**
 * The states a reader needs distinguished, and the words and glyphs for each.
 * GitHub's own vocabulary (`conclusion`, `neutral`, `action_required`) is
 * translated here and does not appear above this module.
 */
export type CheckState = 'passed' | 'failed' | 'running' | 'skipped' | 'missing'

export function checkState(run: CheckRun | undefined): CheckState {
  if (!run) {
    return 'missing'
  }
  if (!run.conclusion) {
    return 'running'
  }
  if (run.conclusion === 'success') {
    return 'passed'
  }
  if (run.conclusion === 'neutral' || run.conclusion === 'skipped') {
    return 'skipped'
  }
  return ATTENTION_CHECK_CONCLUSIONS.has(run.conclusion) ? 'failed' : 'passed'
}

export function stateIcon(state: CheckState): string {
  switch (state) {
    case 'passed':
      return GLYPH.passed
    case 'failed':
      return GLYPH.failed
    case 'running':
      return GLYPH.running
    default:
      return GLYPH.skipped
  }
}

export function checkLink(run: CheckRun | undefined, name: string): string {
  return run?.url ? `[${name}](${run.url})` : name
}

/** A check conclusion in plain English. */
export function conclusionWord(conclusion: string | null): string {
  switch (conclusion) {
    case 'success':
      return 'passed'
    case 'failure':
      return 'failed'
    case 'error':
      return 'errored'
    case 'timed_out':
      return 'timed out'
    case 'action_required':
      return 'needs action'
    case null:
      return 'running'
    default:
      return conclusion
  }
}

/** How long a finished check took, or an em dash while it is running. */
export function checkDuration(run: CheckRun): string {
  if (!run.started_at || !run.completed_at) {
    return GLYPH.none
  }
  const ms = Date.parse(run.completed_at) - Date.parse(run.started_at)
  if (!Number.isFinite(ms) || ms < 0) {
    return GLYPH.none
  }

  const seconds = Math.round(ms / 1000)
  if (seconds < 60) {
    return `${seconds}s`
  }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return `${minutes}m ${seconds % 60}s`
  }
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** The whole check picture in one clause: `2 of 3 green, 1 failing`. */
export function checkTally(runs: CheckRun[]): string {
  if (runs.length === 0) {
    return 'none reported yet'
  }

  const states = runs.map((run) => checkState(run))
  const green = states.filter(
    (state) => state === 'passed' || state === 'skipped',
  ).length
  const running = states.filter((state) => state === 'running').length
  const failed = states.filter((state) => state === 'failed').length

  return [
    `${green} of ${runs.length} green`,
    running ? `${running} running` : null,
    failed ? `${failed} failing` : null,
  ]
    .filter(Boolean)
    .join(', ')
}

/**
 * Failing or running checks that do not hold the merge. Anything the gate
 * already names is listed as a blocker instead, so no check appears twice.
 */
export function alsoFailingLines(
  checkRuns: CheckRun[],
  blockedContexts: Set<string>,
): string[] {
  return [...latestCheckRunsByName(checkRuns).values()]
    .filter((run) => {
      const state = checkState(run)
      return (
        (state === 'failed' || state === 'running') &&
        !blockedContexts.has(run.name)
      )
    })
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(
      (run) =>
        `- ${stateIcon(checkState(run))} ${checkLink(run, run.name)} — ${conclusionWord(run.conclusion)}`,
    )
}

/** Every check as a table, so a long list stays scannable by column. */
export function allCheckRows(checkRuns: CheckRun[]): string[] {
  return [
    '| | Check | Result | Time |',
    '| :-- | :-- | :-- | --: |',
    ...[...latestCheckRunsByName(checkRuns).values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(
        (run) =>
          `| ${stateIcon(checkState(run))} | ${checkLink(run, run.name)} | ${conclusionWord(run.conclusion)} | ${checkDuration(run)} |`,
      ),
  ]
}
