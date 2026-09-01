/**
 * Every glyph any surface renders, defined once.
 *
 * Check conclusions, deployment states and merge blockers are separate
 * vocabularies from separate sources and map onto these independently, but a
 * reader should not have to learn a different symbol for the same outcome
 * depending on which table it appears in.
 */
export const GLYPH = {
  passed: '✅',
  failed: '❌',
  running: '⏳',
  skipped: '⏭',
  unknown: '⚪',
  paused: '⏸',
  warning: '⚠️',
  draft: '📝',
  hold: '✋',
  label: '🏷️',
  refused: '🙅',
  /** Stands in for a value a table has no data for. */
  none: '—',
} as const
