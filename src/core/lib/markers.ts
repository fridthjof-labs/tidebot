/**
 * Comment markers are deliberately App-independent. They identify a comment's
 * purpose, not the bot that wrote it, so an installation that re-registers the
 * App under a new slug still finds and updates its own earlier comments
 * instead of posting duplicates.
 */
export const PIPELINE_COMMENT_MARKER = '<!-- tidebot-pipeline -->'
export const PLAN_SECTION_BEGIN = '<!-- tidebot-plan-begin -->'
export const PLAN_SECTION_END = '<!-- tidebot-plan-end -->'

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

/**
 * Bounds the status block Tidebot maintains inside the pull request body.
 * Everything outside the markers belongs to the author and is preserved.
 */
export const STATUS_BLOCK_BEGIN = '<!-- tidebot-status-begin -->'
export const STATUS_BLOCK_END = '<!-- tidebot-status-end -->'

/**
 * Keys a reply to the comment that asked for it, making the reply an upsert.
 * A second runtime handling the same delivery edits it rather than adding one.
 */
export function commandReplyMarker(commentId: number): string {
  return `<!-- tidebot:reply:${commentId} -->`
}
