import { describe, expect, it, vi } from 'vitest'
import { getChecksForRef } from '../src/core/github.js'

const REF = { owner: 'acme', repo: 'widget' }

function octokitWith(statusesResult: () => Promise<unknown>) {
  return {
    rest: {
      checks: {
        listForRef: vi.fn(async () => ({
          data: {
            check_runs: [
              {
                name: 'Quality / check',
                conclusion: 'success',
                started_at: '2026-01-01T00:00:00Z',
              },
            ],
          },
        })),
      },
      repos: { listCommitStatusesForRef: vi.fn(statusesResult) },
    },
  } as never
}

describe('getChecksForRef', () => {
  it('returns check runs and legacy statuses together', async () => {
    const result = await getChecksForRef(
      octokitWith(async () => ({
        data: [
          {
            context: 'legacy',
            state: 'success',
            created_at: '2026-01-01T00:00:00Z',
          },
        ],
      })),
      REF,
      'abc',
    )
    expect(result.checkRuns).toHaveLength(1)
    expect(result.statuses).toEqual([
      {
        context: 'legacy',
        state: 'success',
        created_at: '2026-01-01T00:00:00Z',
      },
    ])
  })

  it('degrades to no statuses when the token lacks statuses: read', async () => {
    // Most repositories have no commit statuses at all; a missing grant must
    // not take down every event that reads the merge gate.
    const result = await getChecksForRef(
      octokitWith(async () => {
        throw Object.assign(
          new Error('Resource not accessible by integration'),
          {
            status: 403,
          },
        )
      }),
      REF,
      'abc',
    )
    expect(result.checkRuns).toHaveLength(1)
    expect(result.statuses).toEqual([])
  })

  it('still surfaces an unexpected failure', async () => {
    await expect(
      getChecksForRef(
        octokitWith(async () => {
          throw Object.assign(new Error('boom'), { status: 500 })
        }),
        REF,
        'abc',
      ),
    ).rejects.toThrow('boom')
  })
})
