import { describe, expect, it } from 'vitest'
import { expandBotPlaceholder } from '../src/core/identity.js'
import {
  evaluateAutoApprove,
  evaluateRule,
} from '../src/core/lib/auto-approve.js'
import type { AutoApproveRule, CheckRun } from '../src/core/types.js'
import { config, IDENTITY, pullRequest } from './helpers.js'

const DOCS_RULE: AutoApproveRule = {
  name: 'docs',
  paths: ['**/*.md', 'LICENSE'],
  excludePaths: ['infra/**'],
  requiredContexts: ['Quality / check'],
}

const PASSING: CheckRun[] = [
  {
    name: 'Quality / check',
    conclusion: 'success',
    started_at: '2026-01-01T00:00:00Z',
  },
]

function evaluate(
  rule: AutoApproveRule,
  overrides: Parameters<typeof pullRequest>[0] = {},
  changedPaths = ['README.md'],
  checkRuns: CheckRun[] = PASSING,
) {
  return evaluateRule(rule, {
    pr: pullRequest(overrides),
    tide: config().tide,
    checkRuns,
    statuses: [],
    changedPaths,
    authors: expandBotPlaceholder(rule.authors, IDENTITY),
  })
}

describe('auto-approve rules', () => {
  it('approves a docs-only change with its checks green', () => {
    expect(evaluate(DOCS_RULE).safe).toBe(true)
  })

  it('refuses when a path falls outside the rule', () => {
    const decision = evaluate(DOCS_RULE, {}, ['README.md', 'src/index.ts'])
    expect(decision.safe).toBe(false)
    expect(decision.reasons).toContain('changed files outside the rule paths')
  })

  it('honours excludePaths inside an otherwise matching set', () => {
    expect(evaluate(DOCS_RULE, {}, ['infra/README.md']).safe).toBe(false)
  })

  it('refuses while a required check is still pending', () => {
    const decision = evaluate(
      DOCS_RULE,
      {},
      ['README.md'],
      [
        {
          name: 'Quality / check',
          conclusion: null,
          started_at: '2026-01-01T00:00:00Z',
        },
      ],
    )
    expect(decision.reasons).toContain('missing passing check Quality / check')
  })

  it('is blocked by the tide hold label', () => {
    const decision = evaluate(DOCS_RULE, { labels: [{ name: 'hold' }] })
    expect(decision.reasons).toContain('blocked by label hold')
  })

  it('is blocked by a rule-specific label', () => {
    const decision = evaluate(
      { ...DOCS_RULE, blockedLabels: ['area/infra'] },
      { labels: [{ name: 'area/infra' }] },
    )
    expect(decision.reasons).toContain('blocked by label area/infra')
  })

  it('resolves ${bot} to this App login', () => {
    const rule: AutoApproveRule = {
      name: 'generated',
      authors: ['${bot}'],
      paths: ['generated/**'],
    }
    expect(
      evaluate(rule, { userLogin: 'tidebot[bot]' }, ['generated/a.json']).safe,
    ).toBe(true)
    expect(
      evaluate(rule, { userLogin: 'someone' }, ['generated/a.json']).safe,
    ).toBe(false)
  })

  it('refuses a pull request that is not merge-ready', () => {
    expect(evaluate(DOCS_RULE, { draft: true }).reasons).toContain(
      'PR is not merge-ready',
    )
  })

  it('allows an unstable pull request when its explicit checks pass', () => {
    expect(evaluate(DOCS_RULE, { mergeable_state: 'unstable' }).safe).toBe(true)
  })

  it('refuses a pull request with conflicts', () => {
    expect(
      evaluate(DOCS_RULE, {
        mergeable: false,
        mergeable_state: 'dirty',
      }).reasons,
    ).toContain('PR is not merge-ready')
  })

  it('honours maxChangedLines', () => {
    const rule = { ...DOCS_RULE, maxChangedLines: 5 }
    expect(evaluate(rule, { additions: 10, deletions: 2 }).safe).toBe(false)
    expect(evaluate(rule, { additions: 2, deletions: 1 }).safe).toBe(true)
  })
})

describe('evaluateAutoApprove', () => {
  it('is off unless the plugin is enabled', () => {
    const decision = evaluateAutoApprove({
      pr: pullRequest(),
      config: config({ autoApprove: { rules: [DOCS_RULE] } }),
      checkRuns: PASSING,
      statuses: [],
      changedPaths: ['README.md'],
      resolveAuthors: () => [],
    })
    expect(decision.safe).toBe(false)
    expect(decision.reasons).toEqual(['auto-approve disabled'])
  })

  it('returns the first rule that matches', () => {
    const decision = evaluateAutoApprove({
      pr: pullRequest(),
      config: config({
        plugins: { autoApprove: true },
        autoApprove: {
          rules: [
            { name: 'generated', authors: ['bot[bot]'], paths: ['x/**'] },
            DOCS_RULE,
          ],
        },
      }),
      checkRuns: PASSING,
      statuses: [],
      changedPaths: ['README.md'],
      resolveAuthors: (rule) => rule.authors ?? [],
    })
    expect(decision.safe).toBe(true)
    expect(decision.rule).toBe('docs')
  })
})
