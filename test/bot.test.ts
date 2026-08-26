import { describe, expect, it, vi } from 'vitest'
import { handlePullRequest } from '../src/core/bot.js'
import type { PullRequest } from '../src/core/types.js'
import { config, context, pullRequest } from './helpers.js'

type FakeState = {
  pr: PullRequest
  labels: string[]
  checkRuns: Array<{
    name: string
    conclusion: string | null
    started_at: string
  }>
  changedPaths: string[]
  comments: Array<{ id: number; body: string }>
}

/**
 * A fake Octokit narrow enough to read: it records the calls the assertions
 * care about and returns plausible shapes for the rest.
 */
function fakeOctokit(state: FakeState) {
  const merge = vi.fn().mockResolvedValue({})
  const addLabels = vi.fn(async ({ labels }: { labels: string[] }) => {
    state.labels.push(...labels)
    return {}
  })
  const removeLabel = vi.fn().mockResolvedValue({})
  const createComment = vi.fn(async ({ body }: { body: string }) => {
    state.comments.push({ id: state.comments.length + 1, body })
    return {}
  })
  const updateComment = vi.fn(
    async ({ comment_id, body }: { comment_id: number; body: string }) => {
      const comment = state.comments.find((entry) => entry.id === comment_id)
      if (comment) {
        comment.body = body
      }
      return {}
    },
  )

  const octokit = {
    paginate: {
      iterator: (endpoint: unknown) =>
        endpoint === octokit.rest.pulls.listFiles
          ? [{ data: state.changedPaths.map((filename) => ({ filename })) }]
          : [{ data: [] }],
    },
    graphql: vi.fn(),
    rest: {
      pulls: {
        listFiles: vi.fn(),
        merge,
        // The pipeline summary re-reads the pull request, so the fake serves
        // the live state (labels added earlier in the same run included).
        get: vi.fn(async () => ({
          data: {
            node_id: state.pr.id,
            draft: state.pr.draft,
            state: state.pr.state,
            title: state.pr.title,
            body: state.pr.body,
            mergeable: state.pr.mergeable,
            mergeable_state: state.pr.mergeable_state,
            labels: state.labels.map((name) => ({ name })),
            additions: state.pr.additions,
            deletions: state.pr.deletions,
            updated_at: state.pr.updated_at,
            base: { ref: 'main' },
            head: {
              sha: state.pr.head.sha,
              ref: state.pr.head.ref,
              repo: { full_name: 'acme/widget' },
            },
            user: { login: state.pr.userLogin },
          },
        })),
        updateBranch: vi.fn().mockResolvedValue({ data: {}, status: 202 }),
        createReview: vi.fn().mockResolvedValue({}),
        listReviews: vi.fn().mockResolvedValue({ data: [] }),
      },
      issues: {
        addLabels,
        removeLabel,
        listLabelsOnIssue: vi.fn(async () => ({
          data: state.labels.map((name) => ({ name })),
        })),
        listComments: vi.fn(async () => ({ data: state.comments })),
        createComment,
        updateComment,
        deleteComment: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
      },
      checks: {
        listForRef: vi.fn(async () => ({
          data: { check_runs: state.checkRuns },
        })),
      },
      repos: {
        listCommitStatusesForRef: vi.fn(async () => ({ data: [] })),
        listDeployments: vi.fn(),
        listDeploymentStatuses: vi.fn(async () => ({ data: [] })),
      },
      git: {
        getCommit: vi.fn(async () => ({
          data: { committer: { date: new Date().toISOString() } },
        })),
      },
    },
  }

  return { octokit: octokit as never, merge, addLabels, createComment }
}

const GREEN = [
  {
    name: 'Quality / check',
    conclusion: 'success',
    started_at: '2026-01-01T00:00:00Z',
  },
]

describe('handlePullRequest', () => {
  it('merges when the labels and required checks are satisfied', async () => {
    const pr = pullRequest({ labels: [{ name: 'lgtm' }, { name: 'approved' }] })
    const state: FakeState = {
      pr,
      labels: ['lgtm', 'approved'],
      checkRuns: GREEN,
      changedPaths: ['src/a.ts'],
      comments: [],
    }
    const { octokit, merge } = fakeOctokit(state)

    await handlePullRequest(
      context({
        octokit,
        config: config({ tide: { requiredContexts: ['Quality / check'] } }),
      }),
      42,
      pr,
    )

    expect(merge).toHaveBeenCalledWith(
      expect.objectContaining({ pull_number: 42, merge_method: 'squash' }),
    )
  })

  it('does not merge while a required check is red', async () => {
    const pr = pullRequest({ labels: [{ name: 'lgtm' }, { name: 'approved' }] })
    const state: FakeState = {
      pr,
      labels: ['lgtm', 'approved'],
      checkRuns: [
        {
          name: 'Quality / check',
          conclusion: 'failure',
          started_at: '2026-01-01T00:00:00Z',
        },
      ],
      changedPaths: ['src/a.ts'],
      comments: [],
    }
    const { octokit, merge } = fakeOctokit(state)

    await handlePullRequest(
      context({
        octokit,
        config: config({ tide: { requiredContexts: ['Quality / check'] } }),
      }),
      42,
      pr,
    )

    expect(merge).not.toHaveBeenCalled()
  })

  it('auto-approves a docs-only change, then merges it', async () => {
    const state: FakeState = {
      pr: pullRequest(),
      labels: [],
      checkRuns: GREEN,
      changedPaths: ['README.md'],
      comments: [],
    }
    const { octokit, addLabels, merge } = fakeOctokit(state)

    await handlePullRequest(
      context({
        octokit,
        config: config({
          plugins: { autoApprove: true },
          tide: { requiredContexts: ['Quality / check'] },
          autoApprove: {
            rules: [
              {
                name: 'docs',
                paths: ['**/*.md'],
                requiredContexts: ['Quality / check'],
              },
            ],
          },
        }),
      }),
      42,
      pullRequest(),
    )

    expect(addLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ['lgtm', 'approved'] }),
    )
    expect(merge).toHaveBeenCalled()
  })

  it('applies the size label from the diff', async () => {
    const state: FakeState = {
      pr: pullRequest({ additions: 400, deletions: 50 }),
      labels: [],
      checkRuns: [],
      changedPaths: [],
      comments: [],
    }
    const { octokit, addLabels } = fakeOctokit(state)

    await handlePullRequest(
      context({
        octokit,
        config: config({ plugins: { tide: false, commands: false } }),
      }),
      42,
      pullRequest({ additions: 400, deletions: 50 }),
    )

    expect(addLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ['size/l'] }),
    )
  })

  it('upserts one pipeline comment rather than posting a new one each time', async () => {
    const pr = pullRequest({ labels: [{ name: 'lgtm' }] })
    const state: FakeState = {
      pr,
      labels: ['lgtm'],
      checkRuns: GREEN,
      changedPaths: ['src/a.ts'],
      comments: [],
    }
    const { octokit, createComment } = fakeOctokit(state)
    const ctx = context({ octokit })

    await handlePullRequest(ctx, 42, pr)
    await handlePullRequest(ctx, 42, pr)

    expect(createComment).toHaveBeenCalledTimes(1)
    expect(state.comments[0].body).toMatch('### Pipeline status')
  })
})
