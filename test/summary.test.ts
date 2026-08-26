import { describe, expect, it } from 'vitest'
import {
  extractPlanSection,
  formatPipelineSummary,
} from '../src/core/lib/summary.js'
import { config, pullRequest } from './helpers.js'

const GREEN = [
  {
    name: 'Quality / check',
    conclusion: 'success',
    started_at: '2026-01-01T00:00:00Z',
  },
]

describe('formatPipelineSummary', () => {
  it('omits the preview table when no preview apps are configured', () => {
    const body = formatPipelineSummary({
      checkRuns: GREEN,
      deployments: [],
      tide: { ready: true, reasons: [] },
      pr: pullRequest(),
      config: config(),
    })

    expect(body).not.toMatch('Preview deployments')
    expect(body).toMatch('1/1 green')
    expect(body).toMatch('✅ ready to merge')
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
      tide: { ready: false, reasons: ['missing label lgtm'] },
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
    expect(body).toMatch('⏸ blocked — missing label lgtm')
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
      tide: { ready: true, reasons: [] },
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
      tide: { ready: true, reasons: [] },
      pr: pullRequest(),
      config: config({
        plugins: { pipeline: true },
        pipeline: { previewApps: [{ name: 'Site' }] },
      }),
    })
    expect(withoutDeploy).not.toMatch('/deploy')
  })
})

describe('extractPlanSection', () => {
  it('round-trips a plan section through the comment body', () => {
    const body = formatPipelineSummary({
      checkRuns: GREEN,
      deployments: [],
      tide: { ready: true, reasons: [] },
      pr: pullRequest(),
      config: config(),
      planSection: '**Summary:** 1 add, 0 change, 0 destroy',
    })
    expect(extractPlanSection(body)).toBe(
      '**Summary:** 1 add, 0 change, 0 destroy',
    )
  })

  it('returns null when there is no section', () => {
    expect(extractPlanSection('### Pipeline status')).toBeNull()
  })
})
