import type { BotConfig } from '../types.js'

export function areaLabelsForPaths(
  paths: string[],
  rules: BotConfig['area']['rules'],
): string[] {
  const labels = new Set<string>()

  for (const path of paths) {
    for (const rule of rules) {
      if (path.startsWith(rule.prefix)) {
        labels.add(rule.label)
      }
    }
  }

  return [...labels].sort()
}
