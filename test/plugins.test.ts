import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  expandBotPlaceholder,
  resetBotIdentityCache,
  resolveBotIdentity,
} from '../src/core/identity.js'
import { handleIssueIntake } from '../src/core/plugins/intake.js'
import { applyStaleRules } from '../src/core/plugins/stale.js'
import { config, context, IDENTITY, pullRequest } from './helpers.js'

beforeEach(() => {
  resetBotIdentityCache()
})

describe('bot identity', () => {
  function appReturning(data: unknown, spy = vi.fn()) {
    return {
      octokit: {
        request: vi.fn(async () => {
          spy()
          return { data }
        }),
      },
    } as never
  }

  it('derives the [bot] login from the App slug', async () => {
    const identity = await resolveBotIdentity(
      appReturning({ id: 7, slug: 'my-bot', name: 'My Bot' }),
    )
    expect(identity).toEqual({
      appId: 7,
      slug: 'my-bot',
      name: 'My Bot',
      login: 'my-bot[bot]',
    })
  })

  it('asks GitHub once and reuses the answer', async () => {
    const spy = vi.fn()
    const app = appReturning({ id: 7, slug: 'my-bot', name: 'My Bot' }, spy)
    await resolveBotIdentity(app)
    await resolveBotIdentity(app)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('does not cache a failure', async () => {
    const app = {
      octokit: {
        request: vi.fn(async () => {
          throw new Error('boom')
        }),
      },
    } as never
    await expect(resolveBotIdentity(app)).rejects.toThrow('boom')
    await expect(resolveBotIdentity(app)).rejects.toThrow('boom')
    expect(
      (app as { octokit: { request: { mock: { calls: unknown[] } } } }).octokit
        .request.mock.calls,
    ).toHaveLength(2)
  })

  it('expands the ${bot} placeholder a config can write', () => {
    expect(
      expandBotPlaceholder(['${bot}', 'dependabot[bot]'], IDENTITY),
    ).toEqual(['tidebot[bot]', 'dependabot[bot]'])
  })
})

describe('stale rules', () => {
  const DAY = 24 * 60 * 60 * 1000
  const now = Date.parse('2026-03-01T00:00:00Z')

  function octokitWithLastCommit(daysAgo: number) {
    const addLabels = vi.fn()
    const update = vi.fn()
    const createComment = vi.fn()
    return {
      addLabels,
      update,
      createComment,
      octokit: {
        rest: {
          git: {
            getCommit: vi.fn(async () => ({
              data: {
                committer: {
                  date: new Date(now - daysAgo * DAY).toISOString(),
                },
              },
            })),
          },
          issues: { addLabels, update, createComment },
        },
      } as never,
    }
  }

  const staleConfig = config({ plugins: { stale: true } })

  it('does nothing while the branch is recent', async () => {
    const { octokit, addLabels } = octokitWithLastCommit(3)
    await applyStaleRules(
      context({ octokit, config: staleConfig }),
      1,
      pullRequest(),
      now,
    )
    expect(addLabels).not.toHaveBeenCalled()
  })

  it('labels stale after the configured idle period', async () => {
    const { octokit, addLabels, createComment } = octokitWithLastCommit(15)
    await applyStaleRules(
      context({ octokit, config: staleConfig }),
      1,
      pullRequest(),
      now,
    )
    expect(addLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ['stale'] }),
    )
    expect(createComment).toHaveBeenCalled()
  })

  it('closes only after the extra grace period, once already labelled', async () => {
    const { octokit, update } = octokitWithLastCommit(18)
    await applyStaleRules(
      context({ octokit, config: staleConfig }),
      1,
      pullRequest({ labels: [{ name: 'stale' }] }),
      now,
    )
    expect(update).not.toHaveBeenCalled()

    const closing = octokitWithLastCommit(22)
    await applyStaleRules(
      context({ octokit: closing.octokit, config: staleConfig }),
      1,
      pullRequest({ labels: [{ name: 'stale' }] }),
      now,
    )
    expect(closing.update).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'closed', state_reason: 'not_planned' }),
    )
  })

  it('leaves an exempt pull request alone however old', async () => {
    const { octokit, addLabels } = octokitWithLastCommit(500)
    await applyStaleRules(
      context({ octokit, config: staleConfig }),
      1,
      pullRequest({ labels: [{ name: 'hold' }] }),
      now,
    )
    expect(addLabels).not.toHaveBeenCalled()
  })
})

describe('issue intake', () => {
  function octokitFor(existingIssues: unknown[] = []) {
    const create = vi.fn(async () => ({
      data: { number: 12, html_url: 'https://example/12' },
    }))
    const createComment = vi.fn()
    return {
      create,
      createComment,
      octokit: {
        rest: {
          issues: {
            listForRepo: vi.fn(async () => ({ data: existingIssues })),
            create,
            createComment,
          },
        },
      } as never,
    }
  }

  const comment = {
    body: '/bug the widget explodes',
    commentId: 99,
    issueNumber: 5,
    authorAssociation: 'MEMBER',
    userLogin: 'maintainer',
  }

  it('creates a labelled issue from a trusted comment', async () => {
    const { octokit, create } = octokitFor()
    await handleIssueIntake(context({ octokit }), comment)
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'the widget explodes',
        labels: ['bug'],
      }),
    )
  })

  it('is idempotent when GitHub redelivers the webhook', async () => {
    // The source comment id is embedded in the generated issue, so a retry
    // finds the existing one instead of filing a duplicate.
    const { octokit, create, createComment } = octokitFor([
      {
        number: 12,
        html_url: 'https://example/12',
        user: { login: IDENTITY.login },
        body: '<!-- tidebot-intake:comment:99 -->',
      },
    ])
    await handleIssueIntake(context({ octokit }), comment)
    expect(create).not.toHaveBeenCalled()
    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('Found existing'),
      }),
    )
  })

  it('refuses an untrusted author', async () => {
    const { octokit, create } = octokitFor()
    await handleIssueIntake(context({ octokit }), {
      ...comment,
      authorAssociation: 'NONE',
    })
    expect(create).not.toHaveBeenCalled()
  })

  it('ignores a comment that is not an intake command', async () => {
    const { octokit, createComment } = octokitFor()
    const handled = await handleIssueIntake(context({ octokit }), {
      ...comment,
      body: 'just a thought',
    })
    expect(handled).toBe(false)
    expect(createComment).not.toHaveBeenCalled()
  })
})
