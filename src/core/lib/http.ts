/**
 * The HTTP status an Octokit rejection carries, or null when it is not one.
 *
 * Every caller that treats a particular status as expected needs this same
 * narrowing, and doing it inline invites getting one of the clauses wrong.
 */
export function httpStatus(error: unknown): number | null {
  if (typeof error !== 'object' || error === null || !('status' in error)) {
    return null
  }
  const { status } = error as { status: unknown }
  return typeof status === 'number' ? status : null
}

/** True when the rejection is an HTTP error with one of these statuses. */
export function hasHttpStatus(error: unknown, ...statuses: number[]): boolean {
  const status = httpStatus(error)
  return status !== null && statuses.includes(status)
}

/** GitHub's own message for a rejection, lowercased for matching. */
export function httpMessage(error: unknown): string {
  return error instanceof Error ? error.message.toLowerCase() : ''
}
