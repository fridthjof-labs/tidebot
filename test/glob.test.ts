import { describe, expect, it } from 'vitest'
import { matchesGlob, pathsAreWithin } from '../src/core/lib/glob.js'

describe('matchesGlob', () => {
  it('matches a literal path', () => {
    expect(matchesGlob('LICENSE', 'LICENSE')).toBe(true)
    expect(matchesGlob('LICENSE.md', 'LICENSE')).toBe(false)
  })

  it('treats a bare directory name as a prefix', () => {
    expect(matchesGlob('infra/main.tf', 'infra')).toBe(true)
    expect(matchesGlob('infra/main.tf', 'infra/')).toBe(true)
    expect(matchesGlob('infrastructure/main.tf', 'infra/')).toBe(false)
  })

  it('keeps a single star inside one segment', () => {
    expect(matchesGlob('docs/a.md', 'docs/*.md')).toBe(true)
    expect(matchesGlob('docs/nested/a.md', 'docs/*.md')).toBe(false)
  })

  it('lets a leading double star match zero directories', () => {
    expect(matchesGlob('README.md', '**/*.md')).toBe(true)
    expect(matchesGlob('docs/deep/README.md', '**/*.md')).toBe(true)
  })
})

describe('pathsAreWithin', () => {
  it('is false for an empty change set', () => {
    expect(pathsAreWithin([], ['**/*.md'])).toBe(false)
  })

  it('requires every path to match', () => {
    expect(pathsAreWithin(['a.md', 'b.md'], ['**/*.md'])).toBe(true)
    expect(pathsAreWithin(['a.md', 'src/a.ts'], ['**/*.md'])).toBe(false)
  })

  it('honours excludes', () => {
    expect(pathsAreWithin(['infra/README.md'], ['**/*.md'], ['infra/**'])).toBe(
      false,
    )
  })
})
