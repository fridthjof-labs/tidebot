import type { CheckRun, Status } from '../types.js'

const PASSING_CHECK_CONCLUSIONS = new Set(['success', 'neutral'])

const PASSING_STATUS_STATES = new Set(['success'])

export function latestCheckRunsByName(
  checkRuns: CheckRun[],
): Map<string, CheckRun> {
  const byName = new Map<string, CheckRun>()

  for (const run of checkRuns) {
    const existing = byName.get(run.name)
    if (
      !existing ||
      new Date(run.started_at ?? 0) > new Date(existing.started_at ?? 0)
    ) {
      byName.set(run.name, run)
    }
  }

  return byName
}

function latestStatusesByContext(statuses: Status[]): Map<string, Status> {
  const byContext = new Map<string, Status>()

  for (const status of statuses) {
    const existing = byContext.get(status.context)
    if (
      !existing ||
      new Date(status.created_at) > new Date(existing.created_at)
    ) {
      byContext.set(status.context, status)
    }
  }

  return byContext
}

function contextPasses(
  context: string,
  checkRunsByName: Map<string, CheckRun>,
  statusesByContext: Map<string, Status>,
  allowSkippedContexts: Set<string>,
): boolean {
  const checkRun = checkRunsByName.get(context)
  if (checkRun) {
    return (
      PASSING_CHECK_CONCLUSIONS.has(checkRun.conclusion ?? '') ||
      (checkRun.conclusion === 'skipped' && allowSkippedContexts.has(context))
    )
  }

  const status = statusesByContext.get(context)
  if (status) {
    return PASSING_STATUS_STATES.has(status.state)
  }

  return false
}

export function missingRequiredContexts(
  requiredContexts: string[],
  checkRuns: CheckRun[],
  statuses: Status[],
  allowSkippedContexts: string[] = [],
): string[] {
  const checkRunsByName = latestCheckRunsByName(checkRuns)
  const statusesByContext = latestStatusesByContext(statuses)
  const allowedSkipped = new Set(allowSkippedContexts)

  return requiredContexts.filter(
    (context) =>
      !contextPasses(
        context,
        checkRunsByName,
        statusesByContext,
        allowedSkipped,
      ),
  )
}

const FAILING_CHECK_CONCLUSIONS = new Set([
  'failure',
  'cancelled',
  'timed_out',
  'action_required',
])

const FAILING_STATUS_STATES = new Set(['failure', 'error'])

/**
 * Contexts that reported and lost, as opposed to ones that have not reported
 * yet. A legacy commit status counts here too: a repository still using the
 * statuses API must not look merely "pending" when its check has failed.
 */
export function failedRequiredContexts(
  requiredContexts: string[],
  checkRuns: CheckRun[],
  statuses: Status[],
): string[] {
  const checkRunsByName = latestCheckRunsByName(checkRuns)
  const statusesByContext = latestStatusesByContext(statuses)

  return requiredContexts.filter((context) => {
    const checkRun = checkRunsByName.get(context)
    if (checkRun?.conclusion) {
      return FAILING_CHECK_CONCLUSIONS.has(checkRun.conclusion)
    }
    if (checkRun) {
      return false
    }

    const status = statusesByContext.get(context)
    return status ? FAILING_STATUS_STATES.has(status.state) : false
  })
}

export function pendingRequiredContexts(
  requiredContexts: string[],
  checkRuns: CheckRun[],
): string[] {
  const checkRunsByName = latestCheckRunsByName(checkRuns)

  return requiredContexts.filter((context) => {
    const checkRun = checkRunsByName.get(context)
    return checkRun != null && !checkRun.conclusion
  })
}
