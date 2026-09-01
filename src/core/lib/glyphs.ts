/**
 * The glyph vocabulary every rendered surface shares.
 *
 * Check conclusions and deployment states are different vocabularies from
 * different APIs, so each maps onto these separately, but a reader should not
 * have to learn two sets of symbols for the same five outcomes.
 */
export const GLYPH = {
  passed: '✅',
  failed: '❌',
  running: '⏳',
  skipped: '⏭',
  unknown: '⚪',
} as const
