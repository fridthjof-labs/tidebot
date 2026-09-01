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
  /**
   * The workflow's name, not the plan section's heading. Composing this line
   * from `heading` made the default read "Infrastructure plan apply success"
   * and pushed repositories to rename their plan section to fix it.
   */
  it('names the workflow and the branch it applied on', () => {
    expect(formatApplyComment(PLAN, 'success', 'abcdef1234', 'trunk')).toBe(
      '✅ Infrastructure apply **success** on `trunk` (`abcdef1`).',
    )
  })

  it('says how many apply jobs it left out rather than looking complete', () => {
    const outputs = [{ name: 'OpenTofu / apply (a)', body: 'No changes.' }]

    expect(
      formatApplyComment(PLAN, 'success', 'abcdef1234', 'trunk', outputs, 3),
    ).toMatch('_3 further apply jobs are not shown._')
    expect(
      formatApplyComment(PLAN, 'success', 'abcdef1234', 'trunk', outputs, 1),
    ).toMatch('_1 further apply job is not shown._')
    expect(
      formatApplyComment(PLAN, 'success', 'abcdef1234', 'trunk', outputs, 0),
    ).not.toMatch('not shown')
  })

  it('stays a single line when there is no output to show', () => {
    expect(
      formatApplyComment(PLAN, 'success', 'abcdef1234', 'trunk', []),
    ).not.toMatch('```')
  })

  it('fences a single apply body without labelling it', () => {
    const comment = formatApplyComment(PLAN, 'success', 'abcdef1234', 'trunk', [
      {
        name: 'OpenTofu / apply',
        body: 'Terraform will perform the following actions:\n  + create\nApply: 1 added, 0 changed, 0 destroyed.',
      },
    ])
    expect(comment).toMatch('```hcl')
    expect(comment).toMatch('Apply: 1 added, 0 changed, 0 destroyed.')
    expect(comment).not.toMatch('**OpenTofu / apply**')
  })

  it('labels each leg when a matrix applied more than one target', () => {
    const comment = formatApplyComment(PLAN, 'success', 'abcdef1234', 'trunk', [
      { name: 'OpenTofu / apply (github-platform)', body: 'No changes.' },
      { name: 'OpenTofu / apply (tidebot)', body: 'No changes.' },
    ])
    expect(comment).toMatch('**OpenTofu / apply (github-platform)**')
    expect(comment).toMatch('**OpenTofu / apply (tidebot)**')
  })

  it('does not let apply output break out of its fence', () => {
    const comment = formatApplyComment(PLAN, 'failure', 'abcdef1234', 'trunk', [
      { name: 'OpenTofu / apply', body: 'No changes.\n```\nforged' },
    ])
    expect(comment).toMatch('````')
  })
})
