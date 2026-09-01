import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const handlePullRequest = vi.fn()
const handleIssueComment = vi.fn()
const handleIssueIntakeComment = vi.fn()
const handleDefaultBranchPush = vi.fn()

const getRepositoryInstallationId = vi.fn(async () => 42)
const installationOctokit = { rest: {} }
const createBotClients = vi.fn(async () => ({
  app: {},
  getRepositoryInstallationId,
  getInstallationOctokit: vi.fn(async () => installationOctokit),
}))

vi.mock('../src/core/github.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/github.js')>()),
  createBotClients,
}))

vi.mock('../src/core/bot.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/bot.js')>()),
  buildContext: vi.fn(async (input: Record<string, unknown>) => ({
    ...input,
    config: (await import('../src/core/config/defaults.js')).DEFAULT_CONFIG,
    configProblems: [],
    defaultBranch: input.defaultBranch ?? 'main',
  })),
  handlePullRequest,
  handleIssueComment,
  handleIssueIntakeComment,
  handleDefaultBranchPush,
}))

const { runFromActionEnv } = await import('../src/runtime/action.js')

let dir: string

async function eventFile(payload: unknown): Promise<string> {
  const path = join(dir, 'event.json')
  await writeFile(path, JSON.stringify(payload))
  return path
}

const REPOSITORY = { full_name: 'acme/widget', default_branch: 'main' }

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tidebot-action-'))
  vi.clearAllMocks()
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('action runtime', () => {
  it('refuses to run without an event to act on', async () => {
    await expect(runFromActionEnv({ GITHUB_TOKEN: 't' })).rejects.toThrow(
      /GITHUB_EVENT_NAME and GITHUB_EVENT_PATH/,
    )
  })

  it('refuses to run with no credentials at all', async () => {
    await expect(
      runFromActionEnv({
        GITHUB_EVENT_NAME: 'push',
        GITHUB_EVENT_PATH: await eventFile({ repository: REPOSITORY }),
      }),
    ).rejects.toThrow(/GITHUB_TOKEN/)
  })

  it('uses App credentials only for branch updates', async () => {
    await runFromActionEnv({
      GITHUB_TOKEN: 't',
      TIDEBOT_APP_ID: '123',
      TIDEBOT_PRIVATE_KEY: 'key',
      GITHUB_EVENT_NAME: 'push',
      GITHUB_EVENT_PATH: await eventFile({
        repository: REPOSITORY,
        ref: 'refs/heads/main',
      }),
    })
    expect(createBotClients).toHaveBeenCalledWith(
      expect.objectContaining({ appId: '123' }),
    )
    expect(getRepositoryInstallationId).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'widget',
    })
    expect(handleDefaultBranchPush).toHaveBeenCalledWith(
      expect.objectContaining({
        branchUpdateOctokit: installationOctokit,
        identity: expect.objectContaining({ login: 'github-actions[bot]' }),
      }),
    )
  })

  it.each([{ TIDEBOT_APP_ID: '123' }, { TIDEBOT_PRIVATE_KEY: 'key' }])(
    'rejects incomplete App credentials: %o',
    async (credentials) => {
      await expect(
        runFromActionEnv({
          GITHUB_TOKEN: 't',
          ...credentials,
          GITHUB_EVENT_NAME: 'push',
          GITHUB_EVENT_PATH: await eventFile({ repository: REPOSITORY }),
        }),
      ).rejects.toThrow(/both TIDEBOT_APP_ID and TIDEBOT_PRIVATE_KEY/)
    },
  )

  it('routes a pull_request event', async () => {
    await runFromActionEnv({
      GITHUB_TOKEN: 't',
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_EVENT_PATH: await eventFile({
        repository: REPOSITORY,
        action: 'synchronize',
        before: 'old',
        after: 'abc',
        pull_request: {
          number: 7,
          node_id: 'PR_1',
          state: 'open',
          labels: [],
          head: { sha: 'abc', ref: 'f' },
          base: { ref: 'main' },
          user: { login: 'someone' },
        },
      }),
    })
    expect(handlePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: expect.objectContaining({ login: 'github-actions[bot]' }),
      }),
      7,
      expect.objectContaining({
        head: expect.objectContaining({ sha: 'abc' }),
      }),
      expect.objectContaining({ action: 'synchronize', before: 'old' }),
    )
  })

  it('sends a pull request comment to the command handler', async () => {
    await runFromActionEnv({
      GITHUB_TOKEN: 't',
      GITHUB_EVENT_NAME: 'issue_comment',
      GITHUB_EVENT_PATH: await eventFile({
        repository: REPOSITORY,
        issue: { number: 5, pull_request: { url: 'x' } },
        comment: {
          id: 1,
          body: '/lgtm',
          author_association: 'MEMBER',
          user: { login: 'maintainer' },
        },
      }),
    })
    expect(handleIssueComment).toHaveBeenCalled()
    expect(handleIssueIntakeComment).not.toHaveBeenCalled()
  })

  it('sends a plain issue comment to intake instead', async () => {
    await runFromActionEnv({
      GITHUB_TOKEN: 't',
      GITHUB_EVENT_NAME: 'issue_comment',
      GITHUB_EVENT_PATH: await eventFile({
        repository: REPOSITORY,
        issue: { number: 5 },
        comment: {
          id: 1,
          body: '/bug it broke',
          author_association: 'MEMBER',
          user: { login: 'maintainer' },
        },
      }),
    })
    expect(handleIssueIntakeComment).toHaveBeenCalled()
    expect(handleIssueComment).not.toHaveBeenCalled()
  })

  it('ignores a push to a branch that is not the default', async () => {
    await runFromActionEnv({
      GITHUB_TOKEN: 't',
      GITHUB_EVENT_NAME: 'push',
      GITHUB_EVENT_PATH: await eventFile({
        repository: REPOSITORY,
        ref: 'refs/heads/feature',
      }),
    })
    expect(handleDefaultBranchPush).not.toHaveBeenCalled()
  })

  it('acts on a push to the default branch', async () => {
    await runFromActionEnv({
      GITHUB_TOKEN: 't',
      GITHUB_EVENT_NAME: 'push',
      GITHUB_EVENT_PATH: await eventFile({
        repository: REPOSITORY,
        ref: 'refs/heads/main',
      }),
    })
    expect(handleDefaultBranchPush).toHaveBeenCalled()
  })

  it('does nothing for an event it has no handler for', async () => {
    await runFromActionEnv({
      GITHUB_TOKEN: 't',
      GITHUB_EVENT_NAME: 'release',
      GITHUB_EVENT_PATH: await eventFile({ repository: REPOSITORY }),
    })
    expect(handlePullRequest).not.toHaveBeenCalled()
  })
})
