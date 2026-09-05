import { describe, expect, it, vi } from 'vitest'
import {
  evaluateTide,
  maybeRebaseIfBehind,
  resolveTidePolicy,
} from '../src/core/lib/tide.js'
import { config, pullRequest } from './helpers.js'

const GREEN = [
  {
    name: 'Quality / check',
    conclusion: 'success',
    started_at: '2026-01-01T00:00:00Z',
  },
]

const READY = {
  labels: [{ name: 'lgtm' }, { name: 'approved' }],
}

describe('evaluateTide', () => {
  it('is ready with both labels and green checks', () => {
    const decision = evaluateTide(
      pullRequest(READY),
      config({ tide: { requiredContexts: ['Quality / check'] } }).tide,
      GREEN,
      [],
    )
    expect(decision.ready).toBe(true)
  })

  it('ignores unstable, which only restates the non-required checks', () => {
    const decision = evaluateTide(
      pullRequest({ ...READY, mergeable_state: 'unstable' }),
      config({ tide: { requiredContexts: ['Quality / check'] } }).tide,
      GREEN,
      [],
    )
    expect(decision.ready).toBe(true)
  })

  it('still blocks on the other mergeable states', () => {
    const decision = evaluateTide(
      pullRequest({ ...READY, mergeable_state: 'blocked' }),
      config({ tide: { requiredContexts: ['Quality / check'] } }).tide,
      GREEN,
      [],
    )
    expect(decision.reasons).toEqual(['mergeable_state=blocked'])
  })

  it('names every blocker at once', () => {
    const decision = evaluateTide(
      pullRequest({ labels: [{ name: 'hold' }], draft: true }),
      config({ tide: { requiredContexts: ['Quality / check'] } }).tide,
      [],
      [],
    )
    expect(decision.ready).toBe(false)
    expect(decision.reasons).toEqual(
      expect.arrayContaining([
        'PR is draft',
        'blocked by label hold',
        'missing label lgtm',
        'missing passing check Quality / check',
      ]),
    )
  })

  it('applies a label-matched policy with its own contexts', () => {
    const tide = config({
      tide: {
        requiredContexts: ['Quality / check'],
        policies: [
          {
            name: 'infra',
            matchLabels: ['area/infra'],
            requiredContexts: ['Plan'],
            allowSkippedContexts: ['Plan'],
          },
        ],
      },
    }).tide

    const policy = resolveTidePolicy(
      pullRequest({ labels: [{ name: 'area/infra' }] }),
      tide,
    )
    expect(policy.policyName).toBe('infra')
    expect(policy.requiredContexts).toEqual(['Plan'])
  })
})

describe('maybeRebaseIfBehind', () => {
  const octokit = {} as never

  it('does nothing for a PR that is not behind', async () => {
    const rebased = await maybeRebaseIfBehind(
      octokit,
      { owner: 'acme', repo: 'widget' },
      1,
      pullRequest({ ...READY, mergeable_state: 'clean' }),
      config(),
      'main',
    )
    expect(rebased).toBe(false)
  })

  it('does nothing without full merge intent', async () => {
    const rebased = await maybeRebaseIfBehind(
      octokit,
      { owner: 'acme', repo: 'widget' },
      1,
      pullRequest({ labels: [{ name: 'lgtm' }], mergeable_state: 'behind' }),
      config(),
      'main',
    )
    expect(rebased).toBe(false)
  })

  it('updates an approved PR that is behind', async () => {
    const updateBranch = vi.fn().mockResolvedValue({ data: {}, status: 202 })
    const rebased = await maybeRebaseIfBehind(
      { rest: { pulls: { updateBranch } } } as never,
      { owner: 'acme', repo: 'widget' },
      1,
      pullRequest({ ...READY, mergeable_state: 'behind' }),
      config(),
      'main',
    )
    expect(rebased).toBe(true)
    expect(updateBranch).toHaveBeenCalledOnce()
  })
})
