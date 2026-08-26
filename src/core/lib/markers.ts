/**
 * Comment markers are deliberately App-independent. They identify a comment's
 * purpose, not the bot that wrote it, so an installation that re-registers the
 * App under a new slug still finds and updates its own earlier comments
 * instead of posting duplicates.
 */
export const PIPELINE_COMMENT_MARKER = '<!-- tidebot-pipeline -->'
export const PLAN_SECTION_BEGIN = '<!-- tidebot-plan-begin -->'
export const PLAN_SECTION_END = '<!-- tidebot-plan-end -->'

export function autoMergeMarker(sha: string): string {
  return `<!-- tidebot:auto-merge:${sha} -->`
}

export function autoMergeFailedMarker(sha: string): string {
  return `<!-- tidebot:auto-merge-failed:${sha} -->`
}

export function recoveryMarker(kind: 'rebase' | 'retest', sha: string): string {
  return `<!-- tidebot:${kind}:${sha} -->`
}

export function applyMarker(sha: string): string {
  return `<!-- tidebot:apply:${sha} -->`
}

/** One per repository: the problem is the repository's, not the pull request's. */
export function configErrorMarker(ref: {
  owner: string
  repo: string
}): string {
  return `<!-- tidebot:config-error:${ref.owner}/${ref.repo} -->`
}

export function intakeMarker(commentId: number): string {
  return `<!-- tidebot-intake:comment:${commentId} -->`
}
