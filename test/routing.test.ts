import { Webhooks } from '@octokit/webhooks'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invalidateConfigCache } from '../src/core/config/load.js'
import type { BotClients } from '../src/core/github.js'
import { resetBotIdentityCache } from '../src/core/identity.js'
import { registerWebhookHandlers } from '../src/core/webhooks.js'
import { IDENTITY } from './helpers.js'

/**
 * Drives the real handler registration through Octokit's emitter, so these
 * exercise the routing and gating a delivery actually goes through.
 */
function harness(options: { allowedOwners?: string[] } = {}) {
  const octokit = {
    paginate: { iterator: () => [{ data: [] }] },
    rest: {
      repos: {
        getContent: vi.fn(async () => {
          throw Object.assign(new Error('Not Found'), { status: 404 })
        }),
        listCommitStatusesForRef: vi.fn(async () => ({ data: [] })),
        listDeployments: vi.fn(),
        listDeploymentStatuses: vi.fn(async () => ({ data: [] })),
      },
      pulls: {
        list: vi.fn(async () => ({ data: [] })),
        listFiles: vi.fn(),
        get: vi.fn(async () => ({
          data: {
            node_id: 'PR_1',
            state: 'open',
            labels: [],
            additions: 1,
            deletions: 0,
            head: { sha: 'abc', ref: 'f', repo: { full_name: 'acme/widget' } },
            base: { ref: 'main' },
            user: { login: 'someone' },
          },
        })),
      },
      issues: {
        addLabels: vi.fn(),
        removeLabel: vi.fn(),
        listLabelsOnIssue: vi.fn(async () => ({ data: [] })),
        listComments: vi.fn(async () => ({ data: [] })),
        createComment: vi.fn(),
      },
      checks: { listForRef: vi.fn(async () => ({ data: { check_runs: [] } })) },
      git: {
        getCommit: vi.fn(async () => ({
          data: { committer: { date: new Date().toISOString() } },
        })),
      },
    },
  }

  const getInstallationOctokit = vi.fn(async () => octokit as never)
  const webhooks = new Webhooks({ secret: 'test' })
  const clients = {
    app: {
      octokit: {
        request: vi.fn(async () => ({
          data: { id: 1, slug: IDENTITY.slug, name: 'Tidebot' },
        })),
      },
    },
    webhooks,
    getInstallationOctokit,
    getRepositoryInstallationId: vi.fn(),
    listInstallationRepositories: vi.fn(),
  } as unknown as BotClients

  registerWebhookHandlers(clients, options)
  return { webhooks, getInstallationOctokit, octokit }
}

const REPOSITORY = {
  full_name: 'acme/widget',
  default_branch: 'main',
}

beforeEach(() => {
  resetBotIdentityCache()
  invalidateConfigCache()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('event routing', () => {
  it('handles a pull_request event for an installed repository', async () => {
    const { webhooks, getInstallationOctokit } = harness()

    await webhooks.receive({
      id: '1',
      name: 'pull_request',
      payload: {
        action: 'opened',
        installation: { id: 42 },
        repository: REPOSITORY,
        pull_request: {
          number: 7,
          node_id: 'PR_1',
          state: 'open',
          labels: [],
          head: { sha: 'abc', ref: 'f', repo: { full_name: 'acme/widget' } },
          base: { ref: 'main' },
          user: { login: 'someone' },
        },
      } as never,
    })

    expect(getInstallationOctokit).toHaveBeenCalledWith(42)
  })

  it('ignores an event with no installation', async () => {
    const { webhooks, getInstallationOctokit } = harness()

    await webhooks.receive({
      id: '2',
      name: 'pull_request',
      payload: {
        action: 'opened',
        repository: REPOSITORY,
        pull_request: { number: 7, labels: [], head: { sha: 'a' } },
      } as never,
    })

    expect(getInstallationOctokit).not.toHaveBeenCalled()
  })

  it('ignores a repository outside allowedOwners', async () => {
    // The App installation is the real allowlist; this is the second gate for
    // a shared instance that must refuse an installation added by mistake.
    const { webhooks, getInstallationOctokit } = harness({
      allowedOwners: ['someone-else'],
    })

    await webhooks.receive({
      id: '3',
      name: 'pull_request',
      payload: {
        action: 'opened',
        installation: { id: 42 },
        repository: REPOSITORY,
        pull_request: { number: 7, labels: [], head: { sha: 'a' } },
      } as never,
    })

    expect(getInstallationOctokit).not.toHaveBeenCalled()
  })

  it('matches allowedOwners case-insensitively', async () => {
    const { webhooks, getInstallationOctokit } = harness({
      allowedOwners: ['ACME'],
    })

    await webhooks.receive({
      id: '4',
      name: 'pull_request',
      payload: {
        action: 'opened',
        installation: { id: 42 },
        repository: REPOSITORY,
        pull_request: {
          number: 7,
          node_id: 'PR_1',
          state: 'open',
          labels: [],
          head: { sha: 'abc', ref: 'f', repo: { full_name: 'acme/widget' } },
          base: { ref: 'main' },
          user: { login: 'someone' },
        },
      } as never,
    })

    expect(getInstallationOctokit).toHaveBeenCalled()
  })

  it('ignores a push to a branch that is not the default', async () => {
    const { webhooks, octokit } = harness()

    await webhooks.receive({
      id: '5',
      name: 'push',
      payload: {
        ref: 'refs/heads/feature',
        installation: { id: 42 },
        repository: REPOSITORY,
        commits: [],
      } as never,
    })

    expect(octokit.rest.pulls.list).not.toHaveBeenCalled()
  })

  it('ignores a check_suite with no pull requests attached', async () => {
    const { webhooks, getInstallationOctokit } = harness()

    await webhooks.receive({
      id: '6',
      name: 'check_suite',
      payload: {
        action: 'completed',
        installation: { id: 42 },
        repository: REPOSITORY,
        check_suite: { pull_requests: [] },
      } as never,
    })

    expect(getInstallationOctokit).not.toHaveBeenCalled()
  })

  it('ignores a review that was not submitted', async () => {
    const { webhooks, getInstallationOctokit } = harness()

    await webhooks.receive({
      id: '7',
      name: 'pull_request_review',
      payload: {
        action: 'dismissed',
        installation: { id: 42 },
        repository: REPOSITORY,
        pull_request: { number: 7 },
        review: { id: 1, body: '/lgtm', user: { login: 'someone' } },
      } as never,
    })

    expect(getInstallationOctokit).not.toHaveBeenCalled()
  })
})
