import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../src/core/config/defaults.js'
import { deepMerge } from '../src/core/config/merge.js'
import {
  ConfigError,
  parseConfig,
  parsePartialConfig,
  resolveConfig,
} from '../src/core/config/parse.js'

describe('config defaults', () => {
  it('needs no config file at all', () => {
    const config = parseConfig('')
    expect(config.tide.requiredLabels).toEqual(['lgtm', 'approved'])
    expect(config.plugins.tide).toBe(true)
  })

  it('leaves repository-specific plugins off until configured', () => {
    // A fresh install must never merge on a check set the repo never declared.
    expect(DEFAULT_CONFIG.tide.requiredContexts).toEqual([])
    expect(DEFAULT_CONFIG.plugins.dependabot).toBe(false)
    expect(DEFAULT_CONFIG.plugins.autoApprove).toBe(false)
    expect(DEFAULT_CONFIG.plugins.plan).toBe(false)
  })
})

describe('config validation', () => {
  it('rejects an unknown top-level key rather than ignoring it', () => {
    expect(() => parseConfig('tid:\n  mergeMethod: squash')).toThrow(
      ConfigError,
    )
  })

  it('rejects an unknown nested key rather than silently weakening Tide', () => {
    expect(() =>
      parseConfig('tide:\n  requiredContext: [Quality / check]'),
    ).toThrow(/unknown tidebot config key.*tide\.requiredContext/)
  })

  it('rejects unknown keys inside declarative rules', () => {
    expect(() =>
      parseConfig(
        'autoApprove:\n  rules:\n    - name: docs\n      paths: ["**/*.md"]\n      requiredContext: [Quality / check]',
      ),
    ).toThrow(/autoApprove\.rules\[0\]\.requiredContext/)
  })

  it('rejects a merge method GitHub would refuse', () => {
    expect(() => parseConfig('tide:\n  mergeMethod: fast-forward')).toThrow(
      /mergeMethod/,
    )
  })

  it('accepts signed-rebase as an update method', () => {
    expect(
      parseConfig('commands:\n  updateBranchMethod: signed-rebase').commands
        .updateBranchMethod,
    ).toBe('signed-rebase')
  })

  it('accepts the documented plan workflow file', () => {
    const config = parseConfig('plan:\n  workflowFile: infra.yml')
    expect(config.plan.workflowFile).toBe('infra.yml')
  })

  it('refuses an auto-approve rule that constrains nothing', () => {
    expect(() =>
      parseConfig('autoApprove:\n  rules:\n    - name: everything'),
    ).toThrow(/must constrain authors or paths/)
  })

  it('accepts an auto-approve rule constrained by paths', () => {
    const config = parseConfig(
      'autoApprove:\n  rules:\n    - name: docs\n      paths: ["**/*.md"]',
    )
    expect(config.autoApprove.rules[0].paths).toEqual(['**/*.md'])
  })
})

describe('config layering', () => {
  it('lets a repository override an org default', () => {
    const org = parsePartialConfig('tide:\n  mergeMethod: merge')
    const repo = parsePartialConfig('tide:\n  mergeMethod: squash')
    expect(resolveConfig(org, repo).tide.mergeMethod).toBe('squash')
  })

  it('keeps org values the repository did not mention', () => {
    const org = parsePartialConfig('stale:\n  daysUntilStale: 30')
    const repo = parsePartialConfig('plugins:\n  stale: true')
    const merged = resolveConfig(org, repo)
    expect(merged.stale.daysUntilStale).toBe(30)
    expect(merged.plugins.stale).toBe(true)
  })

  it('replaces arrays instead of unioning them', () => {
    // A repository narrowing requiredContexts must get exactly its own list.
    const org = parsePartialConfig('tide:\n  requiredContexts: [a, b]')
    const repo = parsePartialConfig('tide:\n  requiredContexts: [b]')
    expect(resolveConfig(org, repo).tide.requiredContexts).toEqual(['b'])
  })

  it('does not mutate the defaults object', () => {
    deepMerge(DEFAULT_CONFIG, { tide: { mergeMethod: 'merge' } })
    expect(DEFAULT_CONFIG.tide.mergeMethod).toBe('squash')
  })
})
