import type {
  BotConfig,
  CheckRun,
  TideBlocker,
  TideDecision,
} from '../types.js'
import {
  checkLink,
  checkState,
  conclusionWord,
  stateIcon,
} from './check-view.js'
import { latestCheckRunsByName } from './checks.js'
import { GLYPH } from './glyphs.js'

/**
 * The merge gate in English. `evaluateTide` decides whether a pull request
 * merges; this module only decides how to say so.
 */
export type Verdict = {
  /** GitHub alert kind — TIP, NOTE, WARNING, CAUTION. */
  alert: string
  icon: string
  headline: string
  detail: string
}

/**
 * The one line a reviewer should be able to read and stop. Ordered by what a
 * human would act on first: a conflict outranks a failing check, which outranks
 * a check that has not finished, which outranks a missing review label.
 */
export function verdictFor(
  tide: TideDecision,
  checkRuns: CheckRun[],
  config: BotConfig,
): Verdict {
  if (tide.ready) {
    return {
      alert: 'TIP',
      icon: GLYPH.passed,
      headline: 'Ready to merge',
      detail: `Tidebot will ${config.tide.mergeMethod} this as soon as it picks the PR up.`,
    }
  }

  const byName = latestCheckRunsByName(checkRuns)
  const blocked = tide.blockers
  const has = (kind: TideBlocker['kind']) =>
    blocked.some((blocker) => blocker.kind === kind)

  const requiredChecks = blocked.filter(
    (blocker) => blocker.kind === 'missing-check',
  )
  const failingChecks = requiredChecks.filter(
    (blocker) => checkState(byName.get(blocker.context)) === 'failed',
  )

  if (has('draft')) {
    return {
      alert: 'NOTE',
      icon: '📝',
      headline: 'Draft',
      detail: 'Mark the pull request ready for review to arm the merge gate.',
    }
  }

  const holdLabel = blocked.find((blocker) => blocker.kind === 'blocked-label')
  if (holdLabel?.kind === 'blocked-label') {
    return {
      alert: 'WARNING',
      icon: '✋',
      headline: 'On hold',
      detail: `Remove the \`${holdLabel.label}\` label to release the merge gate.`,
    }
  }

  const conflicted = blocked.some(
    (blocker) =>
      blocker.kind === 'conflict' ||
      (blocker.kind === 'mergeable-state' && blocker.state === 'dirty'),
  )
  if (conflicted) {
    return {
      alert: 'CAUTION',
      icon: '⚠️',
      headline: 'Merge conflict',
      detail: 'Resolve the conflicts with the base branch, then push.',
    }
  }

  if (failingChecks.length > 0) {
    const names = failingChecks
      .map((blocker) =>
        blocker.kind === 'missing-check' ? `\`${blocker.context}\`` : '',
      )
      .join(', ')
    return {
      alert: 'CAUTION',
      icon: GLYPH.failed,
      headline:
        failingChecks.length === 1
          ? 'Blocked by a failing check'
          : `Blocked by ${failingChecks.length} failing checks`,
      detail: `${names} must pass before Tidebot will merge.`,
    }
  }

  if (requiredChecks.length > 0) {
    return {
      alert: 'NOTE',
      icon: GLYPH.running,
      headline: 'Waiting on CI',
      detail: 'Required checks have not reported a passing result yet.',
    }
  }

  const missingLabels = blocked
    .filter((blocker) => blocker.kind === 'missing-label')
    .map((blocker) =>
      blocker.kind === 'missing-label' ? `\`${blocker.label}\`` : '',
    )
  if (missingLabels.length > 0) {
    return {
      alert: 'NOTE',
      icon: '👀',
      headline: 'Waiting for review',
      detail: `Needs ${missingLabels.join(' and ')} before the merge gate opens.`,
    }
  }

  if (has('auto-merge-disabled')) {
    return {
      alert: 'NOTE',
      icon: '🙅',
      headline: 'Auto-merge off for this PR',
      detail: 'The matching Tide policy disables auto-merge; merge by hand.',
    }
  }

  return {
    alert: 'NOTE',
    icon: '⏸',
    headline: 'Not merging yet',
    detail: 'See the blockers below.',
  }
}

function mergeableStateText(state: string): string | null {
  switch (state) {
    case 'dirty':
      return 'Merge conflicts with the base branch'
    case 'behind':
      return 'Branch is behind the base branch'
    case 'blocked':
      return 'Branch protection is not satisfied yet'
    case 'unstable':
      return 'A non-required check is failing'
    case 'unknown':
      return 'GitHub has not finished computing mergeability'
    case 'draft':
      // The draft blocker already says this in plainer words.
      return null
    default:
      return `GitHub reports \`mergeable_state=${state}\``
  }
}

/** A glyph per blocker, so the list is scannable. */
function blockerIcon(
  blocker: TideBlocker,
  byName: Map<string, CheckRun>,
): string {
  switch (blocker.kind) {
    case 'draft':
      return '📝'
    case 'not-open':
      return GLYPH.unknown
    case 'conflict':
    case 'mergeable-state':
      return '⚠️'
    case 'auto-merge-disabled':
      return '🙅'
    case 'blocked-label':
      return '✋'
    case 'missing-label':
      return '🏷️'
    case 'missing-check':
      return stateIcon(checkState(byName.get(blocker.context)))
  }
}

function blockerText(
  blocker: TideBlocker,
  byName: Map<string, CheckRun>,
): string | null {
  switch (blocker.kind) {
    case 'draft':
      return 'Pull request is still a draft'
    case 'not-open':
      return `Pull request is ${blocker.state}`
    case 'conflict':
      return 'Pull request has conflicts with the base branch'
    case 'mergeable-state':
      return mergeableStateText(blocker.state)
    case 'auto-merge-disabled':
      return 'Auto-merge is disabled by the matching Tide policy'
    case 'blocked-label':
      return `Blocked by the \`${blocker.label}\` label`
    case 'missing-label':
      return `Missing the \`${blocker.label}\` label`
    case 'missing-check': {
      const run = byName.get(blocker.context)
      const state = checkState(run)
      const suffix =
        state === 'failed'
          ? `${conclusionWord(run?.conclusion ?? null)}`
          : state === 'running'
            ? 'has not finished'
            : state === 'skipped'
              ? 'was skipped'
              : 'has not reported'
      return `Required check ${checkLink(run, `\`${blocker.context}\``)} ${suffix}`
    }
  }
}

/**
 * One line per blocker. `unstable` and `blocked` are dropped when a required
 * check is already named, since they only restate it.
 */
export function blockerLines(
  tide: TideDecision,
  checkRuns: CheckRun[],
): string[] {
  const byName = latestCheckRunsByName(checkRuns)
  const namesACheck = tide.blockers.some(
    (blocker) => blocker.kind === 'missing-check',
  )
  const namesAConflict = tide.blockers.some(
    (blocker) =>
      blocker.kind === 'mergeable-state' && blocker.state === 'dirty',
  )

  return tide.blockers
    .filter((blocker) => {
      if (
        blocker.kind === 'mergeable-state' &&
        (blocker.state === 'unstable' || blocker.state === 'blocked') &&
        namesACheck
      ) {
        return false
      }
      return !(blocker.kind === 'conflict' && namesAConflict)
    })
    .flatMap((blocker) => {
      const text = blockerText(blocker, byName)
      return text ? [`- ${blockerIcon(blocker, byName)} ${text}`] : []
    })
}

/** The required checks the gate is currently waiting on, by name. */
export function blockedCheckContexts(tide: TideDecision): Set<string> {
  return new Set(
    tide.blockers.flatMap((blocker) =>
      blocker.kind === 'missing-check' ? [blocker.context] : [],
    ),
  )
}
