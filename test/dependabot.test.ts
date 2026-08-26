import { describe, expect, it } from 'vitest'
import {
  evaluateDependabotRecovery,
  evaluateDependabotSafety,
  hasHardDependabotBlocker,
  isDependabotAuthor,
  isMajorDependabotUpdate,
} from '../src/core/lib/dependabot.js'
import { config, pullRequest } from './helpers.js'

const ENABLED = config({
  plugins: { dependabot: true },
  dependabot: {
    enabled: true,
    autoApprove: true,
    requiredContexts: ['Quality / check'],
  },
})

const GREEN = [
  {
    name: 'Quality / check',
    conclusion: 'success',
    started_at: '2026-01-01T00:00:00Z',
  },
]

function bot(overrides = {}) {
  return pullRequest({
    userLogin: 'dependabot[bot]',
    title: 'chore(deps): bump vitest from 3.2.4 to 3.2.7',
    labels: [{ name: 'dependencies' }],
    ...overrides,
  })
}

describe('isDependabotAuthor', () => {
  it('recognises both dependabot logins', () => {
    expect(isDependabotAuthor('dependabot[bot]')).toBe(true)
    expect(isDependabotAuthor('dependabot-preview[bot]')).toBe(true)
    expect(isDependabotAuthor('renovate[bot]')).toBe(false)
  })
})

describe('isMajorDependabotUpdate', () => {
  it('reads the semver label', () => {
    expect(
      isMajorDependabotUpdate('bump x', 'version-update:semver-major'),
    ).toBe(true)
  })

  it('compares the versions in the title', () => {
    expect(isMajorDependabotUpdate('bump x from 1.2.3 to 2.0.0')).toBe(true)
    expect(isMajorDependabotUpdate('bump x from 1.2.3 to 1.3.0')).toBe(false)
  })
})

describe('evaluateDependabotSafety', () => {
  it('approves a pinned minor bump with green checks', () => {
    const decision = evaluateDependabotSafety(
      bot(),
      ENABLED.tide,
      ENABLED.dependabot,
      GREEN,
      [],
      ['package.json', 'pnpm-lock.yaml'],
    )
    expect(decision.safe).toBe(true)
  })

  it('refuses a major bump', () => {
    const decision = evaluateDependabotSafety(
      bot({ title: 'bump x from 1.0.0 to 2.0.0' }),
      ENABLED.tide,
      ENABLED.dependabot,
      GREEN,
      [],
      ['package.json'],
    )
    expect(decision.reasons).toContain('major version update')
  })

  it('refuses changes outside the dependency paths', () => {
    const decision = evaluateDependabotSafety(
      bot(),
      ENABLED.tide,
      ENABLED.dependabot,
      GREEN,
      [],
      ['package.json', 'src/index.ts'],
    )
    expect(decision.reasons).toContain(
      'changed files outside allowed dependency paths',
    )
  })

  it('is off unless the plugin is enabled', () => {
    const decision = evaluateDependabotSafety(
      bot(),
      config().tide,
      config().dependabot,
      GREEN,
      [],
      ['package.json'],
    )
    expect(decision.reasons).toContain('dependabot auto-approve disabled')
  })
})

describe('recovery', () => {
  it('treats a hold as a hard blocker', () => {
    expect(hasHardDependabotBlocker(['blocked by label hold'])).toBe(true)
    expect(hasHardDependabotBlocker(['missing passing check X'])).toBe(false)
  })

  it('rebases a behind branch', () => {
    const recovery = evaluateDependabotRecovery(
      bot({ mergeable_state: 'behind' }),
      ENABLED.dependabot,
      GREEN,
      [],
    )
    expect(recovery).toEqual({ rebase: true, retest: false })
  })

  it('retests a failed check rather than rebasing', () => {
    const recovery = evaluateDependabotRecovery(
      bot(),
      ENABLED.dependabot,
      [
        {
          name: 'Quality / check',
          conclusion: 'failure',
          started_at: '2026-01-01T00:00:00Z',
        },
      ],
      [],
    )
    expect(recovery).toEqual({ rebase: false, retest: true })
  })

  it('does nothing while a check is still running', () => {
    const recovery = evaluateDependabotRecovery(
      bot(),
      ENABLED.dependabot,
      [
        {
          name: 'Quality / check',
          conclusion: null,
          started_at: '2026-01-01T00:00:00Z',
        },
      ],
      [],
    )
    expect(recovery).toEqual({ rebase: false, retest: false })
  })
})
