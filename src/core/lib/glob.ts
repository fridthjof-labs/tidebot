/**
 * Minimal glob matcher for changed-path rules. Supports `*` (within a segment),
 * `**` (across segments), `?`, and a trailing `/` meaning "everything under
 * this directory". A pattern with no wildcard matches the exact path or, when
 * it names a directory prefix, anything beneath it — so `infra/` and
 * `infra/**` behave the same way, which is what people write by reflex.
 */
export function matchesGlob(path: string, pattern: string): boolean {
  if (pattern.endsWith('/')) {
    return path.startsWith(pattern)
  }
  if (!/[*?]/.test(pattern)) {
    return path === pattern || path.startsWith(`${pattern}/`)
  }
  return globToRegExp(pattern).test(path)
}

const regExpCache = new Map<string, RegExp>()

function globToRegExp(pattern: string): RegExp {
  const cached = regExpCache.get(pattern)
  if (cached) {
    return cached
  }

  let source = '^'
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]

    if (char === '*') {
      const isDoubleStar = pattern[index + 1] === '*'
      if (isDoubleStar) {
        const followedBySlash = pattern[index + 2] === '/'
        // `**/` also matches zero directories, so `**/*.md` matches `README.md`.
        source += followedBySlash ? '(?:.*/)?' : '.*'
        index += followedBySlash ? 2 : 1
        continue
      }
      source += '[^/]*'
      continue
    }

    if (char === '?') {
      source += '[^/]'
      continue
    }

    source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  source += '$'

  const regExp = new RegExp(source)
  regExpCache.set(pattern, regExp)
  return regExp
}

export function matchesAnyGlob(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesGlob(path, pattern))
}

/** True when every path matches an include pattern and no exclude pattern. */
export function pathsAreWithin(
  paths: string[],
  include: string[],
  exclude: string[] = [],
): boolean {
  if (paths.length === 0) {
    return false
  }
  return paths.every(
    (path) => matchesAnyGlob(path, include) && !matchesAnyGlob(path, exclude),
  )
}
