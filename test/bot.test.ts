import { describe, expect, it, vi } from 'vitest'
import {
  handleDefaultBranchPush,
  handleIssueComment,
  handleIssueIntakeComment,
  handlePullRequest,
  handleWorkflowRun,
} from '../src/core/bot.js'
import type { PullRequest } from '../src/core/types.js'
import { config, context, IDENTITY, pullRequest } from './helpers.js'

type FakeState = {
  pr: PullRequest
  labels: string[]
  checkRuns: Array<{
    name: string
    conclusion: string | null
    started_at: string
  }>
  changedPaths: string[]
  comments: Array<{ id: number; body: string; user: { login: string } }>
}

/**
 * A fake Octokit narrow enough to read: it records the calls the assertions
 * care about and returns plausible shapes for the rest.
 */
function fakeOctokit(state: FakeState) {
  const deleteComment = vi.fn().mockResolvedValue({})
  const merge = vi.fn().mockResolvedValue({})
  const addLabels = vi.fn(async ({ labels }: { labels: string[] }) => {
    state.labels.push(...labels)
    return {}
  })
  const removeLabel = vi.fn().mockResolvedValue({})
  const createComment = vi.fn(async ({ body }: { body: string }) => {
    state.comments.push({
      id: state.comments.length + 1,
      body,
      user: { login: IDENTITY.login },
    })
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
  const updateBranch = vi.fn().mockResolvedValue({ data: {}, status: 202 })

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
        updateBranch,
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
        deleteComment,
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

  return {
    octokit: octokit as never,
    merge,
    addLabels,
    createComment,
    updateComment,
    deleteComment,
    updateBranch,
  }
}

const GREEN = [
  {
    name: 'Quality / check',
    conclusion: 'success',
    started_at: '2026-01-01T00:00:00Z',
  },
]

describe('handlePullRequest', () => {
  it('uses the dedicated client only for branch updates', async () => {
    const pr = pullRequest({
      mergeable_state: 'behind',
      labels: [{ name: 'lgtm' }, { name: 'approved' }],
    })
    const state: FakeState = {
      pr,
      labels: ['lgtm', 'approved'],
      checkRuns: GREEN,
      changedPaths: [],
      comments: [],
    }
    const { octokit, updateBranch: normalUpdateBranch } = fakeOctokit(state)
    const branchUpdate = vi.fn().mockResolvedValue({ data: {}, status: 202 })
    const branchUpdateOctokit = {
      rest: { pulls: { updateBranch: branchUpdate } },
    } as never

    await handlePullRequest(
      context({
        octokit,
        branchUpdateOctokit,
        config: config({
          tide: {
            autoRebaseWhenBehind: true,
            requiredContexts: ['Quality / check'],
          },
        }),
      }),
      42,
      pr,
    )

    expect(branchUpdate).toHaveBeenCalledOnce()
    expect(normalUpdateBranch).not.toHaveBeenCalled()
  })

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

  it('merges only the commit whose checks it evaluated', async () => {
    // Without `sha`, a push landing between the check evaluation and the merge
    // call would merge code nobody reviewed. GitHub returns 409 instead.
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
      expect.objectContaining({ sha: pr.head.sha }),
    )
  })

  it('does nothing but explain itself when the config did not resolve', async () => {
    const pr = pullRequest({ labels: [{ name: 'lgtm' }, { name: 'approved' }] })
    const state: FakeState = {
      pr,
      labels: ['lgtm', 'approved'],
      checkRuns: GREEN,
      changedPaths: ['src/a.ts'],
      comments: [],
    }
    const { octokit, merge, addLabels, createComment } = fakeOctokit(state)

    await handlePullRequest(
      context({
        octokit,
        configProblems: ['acme/widget:.github/tidebot.yaml — unknown key: tid'],
      }),
      42,
      pr,
    )

    // Defaults require no checks, so acting on them would be a weaker gate
    // than the repository asked for.
    expect(merge).not.toHaveBeenCalled()
    expect(addLabels).not.toHaveBeenCalled()
    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('did not resolve'),
      }),
    )
  })

  it('refuses slash commands when the config did not resolve', async () => {
    const state: FakeState = {
      pr: pullRequest(),
      labels: [],
      checkRuns: GREEN,
      changedPaths: [],
      comments: [],
    }
    const { octokit, addLabels, createComment } = fakeOctokit(state)

    await handleIssueComment(
      context({ octokit, configProblems: ['invalid repository config'] }),
      {
        body: '/hold',
        issueNumber: 42,
        authorAssociation: 'MEMBER',
        userLogin: 'maintainer',
      },
    )

    expect(addLabels).not.toHaveBeenCalled()
    expect(createComment).toHaveBeenCalledTimes(1)
    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('did not resolve'),
      }),
    )
  })

  it('refuses issue intake when the config did not resolve', async () => {
    const state: FakeState = {
      pr: pullRequest(),
      labels: [],
      checkRuns: [],
      changedPaths: [],
      comments: [],
    }
    const { octokit, addLabels, createComment } = fakeOctokit(state)

    await handleIssueIntakeComment(
      context({ octokit, configProblems: ['invalid repository config'] }),
      {
        body: '/bug broken intake',
        issueNumber: 7,
        userLogin: 'reporter',
      },
    )

    expect(addLabels).not.toHaveBeenCalled()
    expect(createComment).toHaveBeenCalledTimes(1)
  })

  it('refuses push and workflow automation when the config did not resolve', async () => {
    const list = vi.fn()
    const octokit = {
      rest: { pulls: { list } },
    } as never
    const ctx = context({
      octokit,
      configProblems: ['invalid repository config'],
    })

    await handleDefaultBranchPush(ctx)
    await handleWorkflowRun(ctx, {
      id: 1,
      name: 'Infrastructure',
      event: 'pull_request',
      conclusion: 'success',
      head_sha: 'abc',
      pull_requests: [{ number: 42 }],
    })

    expect(list).not.toHaveBeenCalled()
  })

  it('re-evaluates associated pull requests after a workflow completes', async () => {
    const pr = pullRequest({ labels: [{ name: 'lgtm' }, { name: 'approved' }] })
    const state: FakeState = {
      pr,
      labels: ['lgtm', 'approved'],
      checkRuns: GREEN,
      changedPaths: ['src/a.ts'],
      comments: [],
    }
    const { octokit, merge } = fakeOctokit(state)

    await handleWorkflowRun(
      context({
        octokit,
        config: config({ tide: { requiredContexts: ['Quality / check'] } }),
      }),
      {
        id: 1,
        name: 'CI',
        event: 'workflow_dispatch',
        conclusion: 'success',
        head_sha: pr.head.sha,
        pull_requests: [{ number: 42 }],
      },
    )

    expect(merge).toHaveBeenCalledTimes(1)
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

  it('renders the pipeline summary once per command, not twice', async () => {
    // Each render is roughly ten API calls against a quota the whole
    // installation shares, so a duplicate is a real cost, not a cosmetic one.
    const pr = pullRequest()
    const state: FakeState = {
      pr,
      labels: [],
      checkRuns: GREEN,
      changedPaths: ['src/a.ts'],
      comments: [],
    }
    const { octokit, createComment } = fakeOctokit(state)

    await handleIssueComment(context({ octokit }), {
      body: '/hold',
      commentId: 1,
      issueNumber: 42,
      authorAssociation: 'MEMBER',
      userLogin: 'maintainer',
    })

    const summaries = createComment.mock.calls.filter(
      ([args]: [{ body: string }]) => args.body.includes('### Pipeline status'),
    )
    expect(summaries).toHaveLength(1)
  })

  it('never edits or deletes a comment it did not write', async () => {
    // `issues: write` lets the App edit and delete anyone's comment, so
    // matching a marker alone would hand control of the bot's own bookkeeping
    // to whoever pastes that marker into a comment.
    const pr = pullRequest()
    const impostor = {
      id: 99,
      body: 'nice bot <!-- tidebot-pipeline -->',
      user: { login: 'a-human' },
    }
    const state: FakeState = {
      pr,
      labels: [],
      checkRuns: GREEN,
      changedPaths: ['src/a.ts'],
      comments: [impostor],
    }
    const { octokit, createComment, updateComment, deleteComment } =
      fakeOctokit(state)

    await handlePullRequest(context({ octokit }), 42, pr)

    expect(updateComment).not.toHaveBeenCalled()
    expect(deleteComment).not.toHaveBeenCalled()
    expect(createComment).toHaveBeenCalledTimes(1)
    expect(state.comments[0]).toEqual(impostor)
  })
})
