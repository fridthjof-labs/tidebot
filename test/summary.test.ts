import { describe, expect, it } from 'vitest'
import {
  STATUS_BLOCK_BEGIN,
  STATUS_BLOCK_END,
} from '../src/core/lib/markers.js'
import {
  extractPlanSection,
  formatPipelineSummary,
  formatStatusBlock,
  upsertStatusBlock,
} from '../src/core/lib/summary.js'
import { evaluateTide } from '../src/core/lib/tide.js'
import type { CheckRun, TideDecision } from '../src/core/types.js'
import { config, pullRequest } from './helpers.js'

const GREEN: CheckRun[] = [
  {
    name: 'Quality / check',
    conclusion: 'success',
    started_at: '2026-01-01T00:00:00Z',
  },
]

function decision(overrides: Partial<TideDecision> = {}): TideDecision {
  return { ready: true, blockers: [], reasons: [], ...overrides }
}

describe('formatPipelineSummary', () => {
  it('leads with the verdict and omits sections that have nothing to say', () => {
    const body = formatPipelineSummary({
      checkRuns: GREEN,
      deployments: [],
      tide: decision(),
      pr: pullRequest(),
      config: config(),
    })

    expect(body).toMatch('> [!TIP]')
    expect(body).toMatch('✅ Ready to merge')
    expect(body).toMatch('**Checks** 1 of 1 green')
    expect(body).not.toMatch('Preview deployments')
    expect(body).not.toMatch('Blocking the merge')
    expect(body).not.toMatch('Needs attention')
  })

  it('names the failing check in the headline and links its run', () => {
    const body = formatPipelineSummary({
      checkRuns: [
        ...GREEN,
        {
          name: 'dependency-review',
          conclusion: 'failure',
          started_at: '2026-01-01T00:00:00Z',
          url: 'https://github.test/run/7',
        },
      ],
      deployments: [],
      tide: decision({
        ready: false,
        blockers: [{ kind: 'missing-check', context: 'dependency-review' }],
      }),
      pr: pullRequest(),
      config: config(),
    })

    expect(body).toMatch('> [!CAUTION]')
    expect(body).toMatch('❌ Blocked by a failing check')
    expect(body).toMatch('`dependency-review` must pass')
    expect(body).toMatch(
      'Required check [`dependency-review`](https://github.test/run/7) failed',
    )
  })

  /**
   * The old comment reported `mergeable_state=unstable` next to the check that
   * caused it, which is how a status summary starts reading like a debug dump.
   */
  it('drops a mergeable_state that only restates a named check', () => {
    const body = formatPipelineSummary({
      checkRuns: GREEN,
      deployments: [],
      tide: decision({
        ready: false,
        blockers: [
          { kind: 'mergeable-state', state: 'unstable' },
          { kind: 'missing-check', context: 'dependency-review' },
        ],
      }),
      pr: pullRequest(),
      config: config(),
    })

    expect(body).not.toMatch('mergeable_state')
    expect(body).not.toMatch('non-required check')
    expect(body).toMatch('Required check `dependency-review` has not reported')
  })

  it('translates a mergeable_state that stands on its own', () => {
    const body = formatPipelineSummary({
      checkRuns: GREEN,
      deployments: [],
      tide: decision({
        ready: false,
        blockers: [{ kind: 'mergeable-state', state: 'behind' }],
      }),
      pr: pullRequest(),
      config: config(),
    })

    expect(body).toMatch('Branch is behind the base branch')
    expect(body).not.toMatch('mergeable_state')
  })

  it('says a pending required check is waiting, not failing', () => {
    const body = formatPipelineSummary({
      checkRuns: [
        {
          name: 'validate',
          conclusion: null,
          started_at: '2026-01-01T00:00:00Z',
        },
      ],
      deployments: [],
      tide: decision({
        ready: false,
        blockers: [{ kind: 'missing-check', context: 'validate' }],
      }),
      pr: pullRequest(),
      config: config(),
    })

    expect(body).toMatch('⏳ Waiting on CI')
    expect(body).not.toMatch('CAUTION')
  })

  it('calls out a hold label ahead of everything else', () => {
    const body = formatPipelineSummary({
      checkRuns: GREEN,
      deployments: [],
      tide: decision({
        ready: false,
        blockers: [
          { kind: 'blocked-label', label: 'hold' },
          { kind: 'missing-label', label: 'approved' },
        ],
      }),
      pr: pullRequest({ labels: [{ name: 'hold' }] }),
      config: config(),
    })

    expect(body).toMatch('✋ On hold')
    expect(body).toMatch('Remove the `hold` label')
  })

  it('separates a failing check that does not block the merge', () => {
    const body = formatPipelineSummary({
      checkRuns: [
        ...GREEN,
        {
          name: 'coverage',
          conclusion: 'failure',
          started_at: '2026-01-01T00:00:00Z',
        },
      ],
      deployments: [],
      tide: decision({
        ready: false,
        blockers: [{ kind: 'missing-label', label: 'lgtm' }],
      }),
      pr: pullRequest(),
      config: config(),
    })

    expect(body).toMatch('**Also unhappy, but not blocking**')
    expect(body).toMatch('- ❌ coverage — failed')
  })

  /** The blocking check must not be repeated as an also-unhappy one. */
  it('names a blocking check once', () => {
    const body = formatPipelineSummary({
      checkRuns: [
        {
          name: 'validate',
          conclusion: 'failure',
          started_at: '2026-01-01T00:00:00Z',
        },
      ],
      deployments: [],
      tide: decision({
        ready: false,
        blockers: [{ kind: 'missing-check', context: 'validate' }],
      }),
      pr: pullRequest(),
      config: config(),
    })

    expect(body).not.toMatch('Also unhappy')
    expect(body.match(/Required check/g)).toHaveLength(1)
  })

  it('collapses the full check list behind a details block', () => {
    const body = formatPipelineSummary({
      checkRuns: GREEN,
      deployments: [],
      tide: decision(),
      pr: pullRequest(),
      config: config(),
    })

    expect(body).toMatch('<details><summary>All checks (1)</summary>')
    expect(body).toMatch('| | Check | Result | Time |')
    expect(body).toMatch('| ✅ | Quality / check | passed | — |')
  })

  it('renders a row per configured preview app', () => {
    const body = formatPipelineSummary({
      checkRuns: [
        ...GREEN,
        {
          name: 'Build / site',
          conclusion: 'skipped',
          started_at: '2026-01-01T00:00:00Z',
        },
      ],
      deployments: [],
      tide: decision({
        ready: false,
        blockers: [{ kind: 'missing-label', label: 'lgtm' }],
      }),
      pr: pullRequest(),
      config: config({
        plugins: { pipeline: true },
        pipeline: {
          previewApps: [
            {
              name: 'Site',
              environment: 'Site Preview',
              buildCheck: 'Build / site',
            },
          ],
        },
      }),
    })

    expect(body).toMatch('Preview deployments')
    expect(body).toMatch('| Site | ⏭ skipped |')
    expect(body).toMatch('Missing the `lgtm` label')
  })

  it('prefers a live deployment URL over the configured fallback', () => {
    const body = formatPipelineSummary({
      checkRuns: GREEN,
      deployments: [
        {
          environment: 'Site Preview',
          state: 'success',
          description: 'deployed',
          url: 'https://live.example',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      tide: decision(),
      pr: pullRequest(),
      config: config({
        plugins: { pipeline: true },
        pipeline: {
          previewApps: [
            {
              name: 'Site',
              environment: 'Site Preview',
              url: 'https://fallback.example',
            },
          ],
        },
      }),
    })

    expect(body).toMatch('[Site](https://live.example)')
    expect(body).not.toMatch('fallback.example')
  })

  it('only advertises /deploy when a deploy workflow exists', () => {
    const withoutDeploy = formatPipelineSummary({
      checkRuns: GREEN,
      deployments: [],
      tide: decision(),
      pr: pullRequest(),
      config: config({
        plugins: { pipeline: true },
        pipeline: { previewApps: [{ name: 'Site' }] },
      }),
    })
    expect(withoutDeploy).not.toMatch('/deploy')
  })

  it('reads the same blockers the merge gate acted on', () => {
    const pr = pullRequest({ mergeable_state: 'unstable' })
    const tide = evaluateTide(
      pr,
      config({ tide: { requiredContexts: ['validate'] } }).tide,
      [],
      [],
    )
    const body = formatPipelineSummary({
      checkRuns: [],
      deployments: [],
      tide,
      pr,
      config: config(),
    })

    expect(tide.reasons).toContain('missing passing check validate')
    expect(body).toMatch('Required check `validate` has not reported')
    expect(body).toMatch('Missing the `lgtm` label')
  })
})

describe('formatStatusBlock', () => {
  it('carries the verdict, the tally and a link', () => {
    const block = formatStatusBlock({
      checkRuns: GREEN,
      tide: decision(),
      pr: pullRequest(),
      config: config(),
      commentUrl: 'https://github.test/c/1',
    })

    expect(block.startsWith(STATUS_BLOCK_BEGIN)).toBe(true)
    expect(block.endsWith(STATUS_BLOCK_END)).toBe(true)
    // The same alert the comment uses, so both surfaces read as one thing.
    expect(block).toMatch('> [!TIP]')
    expect(block).toMatch('> **Tidebot — ✅ Ready to merge**')
    expect(block).toMatch(
      '> 1 of 1 green · `abc1234` · [full status](https://github.test/c/1)',
    )
  })

  /**
   * Writing the body raises `pull_request.edited`, which renders this block
   * again. Anything that moved on its own would edit the body forever.
   */
  it('renders identically for unchanged inputs', () => {
    const input = {
      checkRuns: GREEN,
      tide: decision(),
      pr: pullRequest(),
      config: config(),
      commentUrl: null,
    }
    expect(formatStatusBlock(input)).toBe(formatStatusBlock(input))
  })
})

describe('upsertStatusBlock', () => {
  it('appends the block below a body it has not touched before', () => {
    const body = upsertStatusBlock(
      'Fixes #1.',
      `${STATUS_BLOCK_BEGIN}\n> a\n${STATUS_BLOCK_END}`,
    )
    expect(body).toBe(
      `Fixes #1.\n\n${STATUS_BLOCK_BEGIN}\n> a\n${STATUS_BLOCK_END}`,
    )
  })

  it('replaces its own block without disturbing the author text', () => {
    const first = upsertStatusBlock(
      'Fixes #1.',
      `${STATUS_BLOCK_BEGIN}\n> a\n${STATUS_BLOCK_END}`,
    )
    const second = upsertStatusBlock(
      first,
      `${STATUS_BLOCK_BEGIN}\n> b\n${STATUS_BLOCK_END}`,
    )

    expect(second).toBe(
      `Fixes #1.\n\n${STATUS_BLOCK_BEGIN}\n> b\n${STATUS_BLOCK_END}`,
    )
    expect(second).toMatch('Fixes #1.')
  })

  it('is stable once written, so the body stops changing', () => {
    const block = `${STATUS_BLOCK_BEGIN}\n> a\n${STATUS_BLOCK_END}`
    const once = upsertStatusBlock('Fixes #1.', block)
    expect(upsertStatusBlock(once, block)).toBe(once)
  })

  it('handles an empty body', () => {
    const block = `${STATUS_BLOCK_BEGIN}\n> a\n${STATUS_BLOCK_END}`
    expect(upsertStatusBlock(null, block)).toBe(block)
  })
})

describe('extractPlanSection', () => {
  it('round-trips a plan section through the comment body', () => {
    const body = formatPipelineSummary({
      checkRuns: GREEN,
      deployments: [],
      tide: decision(),
      pr: pullRequest(),
      config: config(),
      planSection: '**Summary:** 1 add, 0 change, 0 destroy',
    })
    expect(extractPlanSection(body)).toBe(
      '**Summary:** 1 add, 0 change, 0 destroy',
    )
  })

  it('returns null when there is no section', () => {
    expect(extractPlanSection('no plan here')).toBeNull()
  })
})

describe('preview build checks', () => {
  /**
   * A build check is a check run. Rendering it through the deployment-state
   * vocabulary showed ⚪ for conclusions that vocabulary does not have, while
   * the check table showed ❌ for the same run.
   */
  it.each(['timed_out', 'action_required', 'cancelled'])(
    'agrees with the check table on a %s build check',
    (conclusion) => {
      const runs: CheckRun[] = [
        {
          name: 'Build / site',
          conclusion,
          started_at: '2026-01-01T00:00:00Z',
        },
      ]
      const body = formatPipelineSummary({
        checkRuns: runs,
        deployments: [],
        tide: decision(),
        pr: pullRequest(),
        config: config({
          plugins: { pipeline: true },
          pipeline: {
            previewApps: [{ name: 'Site', buildCheck: 'Build / site' }],
          },
        }),
      })

      const previewRow = body
        .split('\n')
        .find((line) => line.startsWith('| Site |'))
      expect(previewRow).toMatch('❌')
      expect(previewRow).not.toMatch('⚪')
    },
  )
})

describe('a pull request that is over', () => {
  /**
   * The comment is re-rendered by events that arrive after a merge, and under
   * Actions latency the pull request can close between the event and the
   * fetch. A merged pull request reported as blocked reads as a failure, and
   * its blockers are artefacts: GitHub stops computing mergeability once a
   * pull request closes.
   */
  const closedTide = decision({
    ready: false,
    blockers: [
      { kind: 'not-open', state: 'closed' },
      { kind: 'mergeable-state', state: 'unknown' },
    ],
  })

  it('reports a merged pull request as merged', () => {
    const body = formatPipelineSummary({
      checkRuns: GREEN,
      deployments: [],
      tide: closedTide,
      pr: pullRequest({ state: 'closed', merged: true }),
      config: config(),
    })

    expect(body).toMatch('✅ Merged')
    expect(body).not.toMatch('Not merging yet')
    expect(body).not.toMatch('Blocking the merge')
    expect(body).not.toMatch('mergeability')
  })

  it('distinguishes closed without merging', () => {
    const body = formatPipelineSummary({
      checkRuns: GREEN,
      deployments: [],
      tide: closedTide,
      pr: pullRequest({ state: 'closed', merged: false }),
      config: config(),
    })

    expect(body).toMatch('Closed without merging')
    expect(body).not.toMatch('Blocking the merge')
  })

  it('says the same thing in the pull request body', () => {
    const block = formatStatusBlock({
      checkRuns: GREEN,
      tide: closedTide,
      pr: pullRequest({ state: 'closed', merged: true }),
      config: config(),
    })

    expect(block).toMatch('**Tidebot — ✅ Merged**')
  })
})
