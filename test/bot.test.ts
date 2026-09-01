import { describe, expect, it, vi } from 'vitest'
import {
  handleDefaultBranchPush,
  handleIssueComment,
  handleIssueIntakeComment,
  handlePullRequest,
  handleWorkflowRun,
} from '../src/core/bot.js'
import { PIPELINE_COMMENT_MARKER } from '../src/core/lib/markers.js'
import type { PullRequest } from '../src/core/types.js'
import {
  type FakeCheckRun,
  type FakeComment,
  fakeGitHub,
} from './fake-github.js'
import { config, context, IDENTITY, pullRequest } from './helpers.js'

type FakeState = {
  pr: PullRequest
  labels: string[]
  checkRuns: FakeCheckRun[]
  changedPaths: string[]
  comments: FakeComment[]
}

/**
 * The shared in-memory GitHub, wired to this file's authoring shape.
 *
 * Nothing here fakes an endpoint: paging, label removal and comment storage
 * all come from `fakeGitHub`, so a test cannot pass against behaviour GitHub
 * does not have.
 */
function fakeOctokit(state: FakeState) {
  const pullRecord = {
    ...state.pr,
    number: 42,
    // The body lives on the caller's pull request so assertions can read the
    // block Tidebot wrote back.
    get body() {
      return state.pr.body
    },
    set body(value: string | null | undefined) {
      state.pr.body = value ?? null
    },
  }

  const { octokit, spy } = fakeGitHub({
    comments: state.comments,
    labels: { 42: state.labels },
    checkRuns: state.checkRuns,
    changedPaths: state.changedPaths,
    pulls: [pullRecord],
  })

  return {
    octokit,
    merge: spy.merge,
    addLabels: spy.addLabels,
    createComment: spy.createComment,
    updateComment: spy.updateComment,
    deleteComment: spy.deleteComment,
    updateBranch: spy.updateBranch,
    updatePull: spy.updatePull,
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
    // GitHub's own merge event records this; a comment saying so is noise.
    expect(
      state.comments.some((comment) => comment.body.includes('Auto-merged')),
    ).toBe(false)
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
    expect(state.comments[0].body).toMatch(PIPELINE_COMMENT_MARKER)
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

    const summaries = createComment.mock.calls.filter((call) =>
      String((call[0] as { body?: string })?.body ?? '').includes(
        PIPELINE_COMMENT_MARKER,
      ),
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

  /**
   * A repository can end up running Tidebot twice — the App and the in-repo
   * Actions workflow — and each identity used to post its own copy of every
   * marked comment. Whichever runs second must adopt the comment already there.
   */
  /**
   * The status comment is written when the pull request opens, so on a long
   * thread it is not among the newest hundred. Reading one page missed it and
   * posted another one — on exactly the busy pull requests that motivated
   * putting the status in the body in the first place.
   */
  it('finds its comment on a thread longer than one page', async () => {
    const pr = pullRequest()
    const state: FakeState = {
      pr,
      labels: [],
      checkRuns: GREEN,
      changedPaths: ['src/a.ts'],
      comments: [
        {
          id: 1,
          body: `${PIPELINE_COMMENT_MARKER}\nold status`,
          user: { login: IDENTITY.login, type: 'Bot' },
        },
        ...Array.from({ length: 150 }, (_, i) => ({
          id: i + 2,
          body: 'chatter',
          user: { login: 'someone' },
        })),
      ],
    }
    const { octokit, createComment, updateComment } = fakeOctokit(state)

    await handlePullRequest(context({ octokit }), 42, pr)

    expect(createComment).not.toHaveBeenCalled()
    expect(updateComment).toHaveBeenCalledOnce()
    expect(state.comments).toHaveLength(151)
  })

  /**
   * Two runtimes racing, or a lookup that once missed, can leave more than one
   * marked comment. The oldest survives because the pull request body links to
   * it.
   */
  it('prunes duplicate marked comments down to the original', async () => {
    const pr = pullRequest()
    const state: FakeState = {
      pr,
      labels: [],
      checkRuns: GREEN,
      changedPaths: ['src/a.ts'],
      comments: [
        {
          id: 1,
          body: `${PIPELINE_COMMENT_MARKER}\noriginal`,
          user: { login: IDENTITY.login, type: 'Bot' },
        },
        {
          id: 2,
          body: 'a human said something',
          user: { login: 'a-human' },
        },
        {
          id: 3,
          body: `${PIPELINE_COMMENT_MARKER}\nduplicate`,
          user: { login: 'github-actions[bot]', type: 'Bot' },
        },
      ],
    }
    const { octokit, createComment, updateComment, deleteComment } =
      fakeOctokit(state)

    await handlePullRequest(context({ octokit }), 42, pr)

    expect(createComment).not.toHaveBeenCalled()
    expect(updateComment).toHaveBeenCalledOnce()
    expect(deleteComment).toHaveBeenCalledWith({ comment_id: 3 })
    expect(state.comments.map((comment) => comment.id)).toEqual([1, 2])
    expect(state.comments[0].body).not.toMatch('original')
  })

  it('adopts a marked comment another bot identity left', async () => {
    const pr = pullRequest()
    const other = {
      id: 7,
      body: `${PIPELINE_COMMENT_MARKER}\nstale status from the other runtime`,
      user: { login: 'github-actions[bot]', type: 'Bot' },
    }
    const state: FakeState = {
      pr,
      labels: [],
      checkRuns: GREEN,
      changedPaths: ['src/a.ts'],
      comments: [other],
    }
    const { octokit, createComment, updateComment } = fakeOctokit(state)

    await handlePullRequest(context({ octokit }), 42, pr)

    expect(createComment).not.toHaveBeenCalled()
    expect(updateComment).toHaveBeenCalledOnce()
    expect(state.comments).toHaveLength(1)
    expect(state.comments[0].body).not.toMatch('stale status')
  })

  /**
   * The upsert adopts a marked comment another Tidebot identity wrote. Anything
   * reading state back out of that comment has to agree about which comment it
   * is, or adopting one silently discards what it carried.
   */
  it("keeps a plan section carried by another identity's comment", async () => {
    const pr = pullRequest()
    const state: FakeState = {
      pr,
      labels: [],
      checkRuns: GREEN,
      changedPaths: ['src/a.ts'],
      comments: [
        {
          id: 7,
          body: [
            PIPELINE_COMMENT_MARKER,
            '<!-- tidebot-plan-begin -->',
            '**Summary:** 1 add, 0 change, 0 destroy',
            '<!-- tidebot-plan-end -->',
          ].join('\n'),
          user: { login: 'github-actions[bot]', type: 'Bot' },
        },
      ],
    }
    const { octokit } = fakeOctokit(state)

    await handlePullRequest(context({ octokit }), 42, pr)

    expect(state.comments).toHaveLength(1)
    expect(state.comments[0].body).toMatch(
      '**Summary:** 1 add, 0 change, 0 destroy',
    )
  })

  it('mirrors the verdict into the pull request body, then leaves it alone', async () => {
    const pr = pullRequest({ body: 'Fixes #1.' })
    const state: FakeState = {
      pr,
      labels: [],
      checkRuns: GREEN,
      changedPaths: ['src/a.ts'],
      comments: [],
    }
    const { octokit, updatePull } = fakeOctokit(state)

    await handlePullRequest(context({ octokit }), 42, pr)

    expect(updatePull).toHaveBeenCalledOnce()
    expect(state.pr.body).toMatch('Fixes #1.')
    expect(state.pr.body).toMatch('**Tidebot — 🏷️ Waiting for review**')

    // A second pass renders the same block, so it must not write again —
    // every write raises `pull_request.edited` and would loop.
    await handlePullRequest(context({ octokit }), 42, {
      ...pr,
      body: state.pr.body,
    })
    expect(updatePull).toHaveBeenCalledOnce()
  })

  it('leaves the body untouched when statusInBody is off', async () => {
    const pr = pullRequest({ body: 'Fixes #1.' })
    const state: FakeState = {
      pr,
      labels: [],
      checkRuns: GREEN,
      changedPaths: ['src/a.ts'],
      comments: [],
    }
    const { octokit, updatePull } = fakeOctokit(state)

    await handlePullRequest(
      context({
        octokit,
        config: config({ pipeline: { statusInBody: false } }),
      }),
      42,
      pr,
    )

    expect(updatePull).not.toHaveBeenCalled()
    expect(state.pr.body).toBe('Fixes #1.')
  })
})
