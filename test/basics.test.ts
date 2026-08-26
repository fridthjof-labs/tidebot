import { describe, expect, it } from 'vitest'
import { expandBotPlaceholder } from '../src/core/identity.js'
import { areaLabelsForPaths } from '../src/core/lib/area.js'
import {
  failedRequiredContexts,
  missingRequiredContexts,
} from '../src/core/lib/checks.js'
import { autoMergeMarker, intakeMarker } from '../src/core/lib/markers.js'
import { isRateLimitError } from '../src/core/lib/rate-limit.js'
import { sizeLabelForDiff } from '../src/core/lib/size.js'
import { resolveInactiveDays } from '../src/core/plugins/stale.js'
import { config, IDENTITY } from './helpers.js'

describe('size labels', () => {
  it('buckets by total changed lines', () => {
    const size = config().size
    expect(sizeLabelForDiff(5, size)).toBe('size/xs')
    expect(sizeLabelForDiff(50, size)).toBe('size/s')
    expect(sizeLabelForDiff(201, size)).toBe('size/l')
    expect(sizeLabelForDiff(5000, size)).toBe('size/xl')
  })
})

describe('area labels', () => {
  it('is empty when no rules are configured', () => {
    expect(areaLabelsForPaths(['src/a.ts'], [])).toEqual([])
  })

  it('labels each matching prefix once, sorted', () => {
    const rules = [
      { prefix: 'src/', label: 'area/src' },
      { prefix: '.github/', label: 'area/ci' },
    ]
    expect(
      areaLabelsForPaths(['src/a.ts', 'src/b.ts', '.github/ci.yml'], rules),
    ).toEqual(['area/ci', 'area/src'])
  })
})

describe('required contexts', () => {
  const runs = [
    { name: 'a', conclusion: 'success', started_at: '2026-01-01T00:00:00Z' },
    { name: 'b', conclusion: 'failure', started_at: '2026-01-01T00:00:00Z' },
    { name: 'c', conclusion: 'skipped', started_at: '2026-01-01T00:00:00Z' },
  ]

  it('reports the ones that are not passing', () => {
    expect(missingRequiredContexts(['a', 'b', 'c', 'd'], runs, [])).toEqual([
      'b',
      'c',
      'd',
    ])
  })

  it('accepts a skipped check only when allowed', () => {
    expect(missingRequiredContexts(['c'], runs, [], ['c'])).toEqual([])
  })

  it('prefers the most recent run of a name', () => {
    const rerun = [
      { name: 'a', conclusion: 'failure', started_at: '2026-01-01T00:00:00Z' },
      { name: 'a', conclusion: 'success', started_at: '2026-01-02T00:00:00Z' },
    ]
    expect(missingRequiredContexts(['a'], rerun, [])).toEqual([])
  })

  it('separates failing from merely missing', () => {
    expect(failedRequiredContexts(['b', 'd'], runs, [])).toEqual(['b'])
  })

  it('falls back to commit statuses', () => {
    expect(
      missingRequiredContexts(
        ['legacy'],
        [],
        [
          {
            context: 'legacy',
            state: 'success',
            created_at: '2026-01-01T00:00:00Z',
          },
        ],
      ),
    ).toEqual([])
  })
})

describe('stale inactivity', () => {
  const now = Date.parse('2026-01-31T00:00:00Z')

  it('measures from the last commit, not updated_at', () => {
    // The bot's own comments keep bumping updated_at; only the branch is a
    // real signal that someone is still working on the pull request.
    expect(
      Math.round(
        resolveInactiveDays(
          '2026-01-01T00:00:00Z',
          '2026-01-30T00:00:00Z',
          now,
        ),
      ),
    ).toBe(30)
  })

  it('falls back to updated_at when the commit is unreadable', () => {
    expect(
      Math.round(resolveInactiveDays(null, '2026-01-21T00:00:00Z', now)),
    ).toBe(10)
  })
})

describe('identity placeholders', () => {
  it('expands ${bot} and ${slug}', () => {
    expect(expandBotPlaceholder(['${bot}', '${slug}-ci'], IDENTITY)).toEqual([
      'tidebot[bot]',
      'tidebot-ci',
    ])
  })

  it('is empty for an unset list', () => {
    expect(expandBotPlaceholder(undefined, IDENTITY)).toEqual([])
  })
})

describe('comment markers', () => {
  it('does not embed the App slug, so a rename keeps finding old comments', () => {
    expect(autoMergeMarker('abc')).toBe('<!-- tidebot:auto-merge:abc -->')
    expect(intakeMarker(42)).toBe('<!-- tidebot-intake:comment:42 -->')
  })
})

describe('isRateLimitError', () => {
  it('recognises the message GitHub sends', () => {
    expect(
      isRateLimitError(
        Object.assign(
          new Error('API rate limit exceeded for installation ID 1'),
          {
            status: 403,
          },
        ),
      ),
    ).toBe(true)
  })

  it('ignores an unrelated 403', () => {
    expect(
      isRateLimitError(
        Object.assign(new Error('Resource not accessible by integration'), {
          status: 403,
        }),
      ),
    ).toBe(false)
  })
})
