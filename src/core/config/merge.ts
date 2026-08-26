function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== null
  )
}

/**
 * Layer configs from lowest to highest precedence. Objects merge key by key;
 * arrays replace wholesale, so a repository that narrows `requiredContexts`
 * gets exactly the list it wrote rather than the union with the org default.
 */
export function deepMerge<T>(base: T, ...overrides: unknown[]): T {
  let result: unknown = base

  for (const override of overrides) {
    if (override === undefined || override === null) {
      continue
    }
    if (!isPlainObject(result) || !isPlainObject(override)) {
      result = override
      continue
    }

    const merged: Record<string, unknown> = { ...result }
    for (const [key, value] of Object.entries(override)) {
      if (value === undefined) {
        continue
      }
      merged[key] = deepMerge(merged[key], value)
    }
    result = merged
  }

  return result as T
}
