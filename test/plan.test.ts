import { describe, expect, it } from 'vitest'
import {
  formatApplyComment,
  formatPlanSection,
  parsePlanChangeSummary,
  parsePlanLogFromJobLogs,
  trimPlanLogForComment,
} from '../src/core/lib/plan.js'
import { config } from './helpers.js'

const PLAN = config().plan

const JOB_LOG = [
  '2026-01-01T00:00:00.0000000Z Setting up job',
  '2026-01-01T00:00:01.0000000Z TIDEBOT_PLAN_LOG_BEGIN',
  '2026-01-01T00:00:02.0000000Z Initializing provider plugins...',
  '2026-01-01T00:00:03.0000000Z OpenTofu will perform the following actions:',
  '2026-01-01T00:00:04.0000000Z   # cloudflare_record.a will be created',
  '2026-01-01T00:00:05.0000000Z Plan: 1 to add, 0 to change, 0 to destroy.',
  '2026-01-01T00:00:06.0000000Z TIDEBOT_PLAN_LOG_END',
  '2026-01-01T00:00:07.0000000Z Cleaning up',
].join('\n')

describe('parsePlanLogFromJobLogs', () => {
  it('extracts the bracketed plan and strips runner timestamps', () => {
    const plan = parsePlanLogFromJobLogs(JOB_LOG, PLAN)
    expect(plan).toMatch('OpenTofu will perform the following actions:')
    expect(plan).not.toMatch('Setting up job')
    expect(plan).not.toMatch('2026-01-01T')
  })

  it('returns null when the markers are absent', () => {
    expect(parsePlanLogFromJobLogs('no markers here', PLAN)).toBeNull()
  })

  it('honours custom markers', () => {
    const custom = { ...PLAN, logBeginMarker: 'BEGIN', logEndMarker: 'END' }
    expect(parsePlanLogFromJobLogs('BEGIN\nhello\nEND', custom)).toBe('hello')
  })
})

describe('trimPlanLogForComment', () => {
  it('keeps the actions block and its summary line', () => {
    const trimmed = trimPlanLogForComment(
      parsePlanLogFromJobLogs(JOB_LOG, PLAN)!,
      PLAN,
    )
    expect(trimmed.startsWith('OpenTofu will perform')).toBe(true)
    expect(trimmed.endsWith('Plan: 1 to add, 0 to change, 0 to destroy.')).toBe(
      true,
    )
    expect(trimmed).not.toMatch('Initializing provider plugins')
  })

  it('handles a no-changes plan', () => {
    expect(
      trimPlanLogForComment('No changes. Your infrastructure matches.', PLAN),
    ).toBe('No changes. Your infrastructure matches.')
  })

  it('works for Terraform wording too', () => {
    const terraform = [
      'Terraform will perform the following actions:',
      '  # aws_s3_bucket.b will be created',
      'Plan: 1 to add, 0 to change, 0 to destroy.',
    ].join('\n')
    expect(trimPlanLogForComment(terraform, PLAN).startsWith('Terraform')).toBe(
      true,
    )
  })
})

describe('formatPlanSection', () => {
  it('leads with the change summary and the commit', () => {
    const section = formatPlanSection(
      parsePlanLogFromJobLogs(JOB_LOG, PLAN)!,
      PLAN,
      { workflowConclusion: 'success', headSha: 'abcdef1234' },
    )
    expect(section).toMatch('**Summary:** 1 add, 0 change, 0 destroy')
    expect(section).toMatch('Commit: `abcdef1`')
    expect(section).toMatch('```hcl')
  })

  it('calls out a failed workflow', () => {
    const section = formatPlanSection(
      'Plan: 0 to add, 0 to change, 0 to destroy.',
      PLAN,
      {
        workflowConclusion: 'failure',
      },
    )
    expect(section).toMatch('**Workflow:** failure')
  })
})

describe('parsePlanChangeSummary', () => {
  it('reads the three counts', () => {
    expect(
      parsePlanChangeSummary(
        'Plan: 2 to add, 1 to change, 3 to destroy.',
        PLAN,
      ),
    ).toBe('2 add, 1 change, 3 destroy')
  })
})

describe('formatApplyComment', () => {
  it('names the branch it applied on', () => {
    expect(formatApplyComment(PLAN, 'success', 'abcdef1234', 'trunk')).toBe(
      '✅ Infrastructure plan apply **success** on `trunk` (`abcdef1`).',
    )
  })
})
