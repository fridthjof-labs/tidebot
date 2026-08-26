import type { BotConfig } from '../types.js'

const SIZE_ORDER = ['xs', 's', 'm', 'l', 'xl'] as const

export function sizeLabelForDiff(
  lineCount: number,
  config: BotConfig['size'],
): string {
  const { thresholds, labelPrefix } = config
  let bucket: (typeof SIZE_ORDER)[number] = 'xl'

  if (lineCount <= thresholds.xs) {
    bucket = 'xs'
  } else if (lineCount <= thresholds.s) {
    bucket = 's'
  } else if (lineCount <= thresholds.m) {
    bucket = 'm'
  } else if (lineCount <= thresholds.l) {
    bucket = 'l'
  }

  return `${labelPrefix}${bucket}`
}
