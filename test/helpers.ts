import { DEFAULT_CONFIG } from '../src/core/config/defaults.js'
import { deepMerge } from '../src/core/config/merge.js'
import type { BotContext } from '../src/core/context.js'
import type { BotIdentity } from '../src/core/identity.js'
import type { BotConfig, PullRequest } from '../src/core/types.js'

export const IDENTITY: BotIdentity = {
  appId: 1,
  slug: 'tidebot',
  name: 'Tidebot',
  login: 'tidebot[bot]',
}

export function config(overrides: unknown = {}): BotConfig {
  return deepMerge(DEFAULT_CONFIG, overrides)
}

export function pullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    id: 'PR_1',
    draft: false,
    state: 'open',
    title: 'A change',
    body: '',
    mergeable: true,
    mergeable_state: 'clean',
    labels: [],
    additions: 10,
    deletions: 2,
    updated_at: '2026-01-01T00:00:00Z',
    base: { ref: 'main' },
    head: { sha: 'abc1234def', ref: 'feature', repoFullName: 'acme/widget' },
    userLogin: 'someone',
    ...overrides,
  }
}

export function context(overrides: Partial<BotContext> = {}): BotContext {
  return {
    // Tests inject only the endpoints the code under test actually calls.
    octokit: { rest: {} } as unknown as BotContext['octokit'],
    ref: { owner: 'acme', repo: 'widget' },
    config: config(),
    identity: IDENTITY,
    defaultBranch: 'main',
    ...overrides,
  }
}
