import { describe, expect, it, vi } from 'vitest'
import {
  downloadWorkflowJobLogs,
  getChecksForRef,
  submitPullRequestApproval,
} from '../src/core/github.js'

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

describe('downloadWorkflowJobLogs', () => {
  it('rejects a job log that exceeds the Worker memory budget', async () => {
    const fetch = vi.fn(
      async () =>
        new Response('ignored', {
          headers: { 'content-length': String(9 * 1024 * 1024) },
        }),
    )
    vi.stubGlobal('fetch', fetch)
    const octokit = {
      rest: {
        actions: {
          listJobsForWorkflowRun: vi.fn(async () => ({
            data: { jobs: [{ id: 1, name: 'plan' }] },
          })),
        },
      },
      request: vi.fn(async () => ({
        headers: { location: 'https://logs.example/job' },
      })),
    } as never

    await expect(
      downloadWorkflowJobLogs(octokit, REF, 1, 'plan'),
    ).resolves.toBeNull()
    vi.unstubAllGlobals()
  })
})

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

describe('submitPullRequestApproval', () => {
  function octokitRejectingWith(error: unknown) {
    return {
      rest: {
        pulls: {
          createReview: vi.fn(async () => {
            throw error
          }),
        },
      },
    } as never
  }

  it('treats a duplicate approval as success', async () => {
    const result = await submitPullRequestApproval(
      octokitRejectingWith(
        Object.assign(
          new Error('Review has already approved this pull request'),
          {
            status: 422,
          },
        ),
      ),
      REF,
      1,
      'abc',
      'body',
    )
    expect(result.approved).toBe(true)
  })

  it('does not claim success for a 422 that refused the review', async () => {
    // GitHub answers 422 for a self-approval too. Reporting that as approved
    // told the requester a review existed that GitHub had refused to create.
    const result = await submitPullRequestApproval(
      octokitRejectingWith(
        Object.assign(new Error('Can not approve your own pull request'), {
          status: 422,
        }),
      ),
      REF,
      1,
      'abc',
      'body',
    )
    expect(result.approved).toBe(false)
    expect(result.message).toMatch(/own pull request/)
  })
})
