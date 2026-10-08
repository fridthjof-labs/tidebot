import { describe, expect, it } from 'vitest'
import { handlePullRequest } from '../src/core/bot.js'
import { getPullRequestChangedPaths } from '../src/core/github/pulls.js'
import { applyAreaLabels } from '../src/core/plugins/area-labeler.js'
import { maybeAutoApprove } from '../src/core/plugins/auto-approve.js'
import { maybeAutoApproveDependabot } from '../src/core/plugins/dependabot.js'
import { type FakeGitHubState, fakeGitHub } from './fake-github.js'
import { config, context, pullRequest } from './helpers.js'

const ref = { owner: 'acme', repo: 'widget' }
const passing = [{ name: 'Quality / check', conclusion: 'success' }]

function github(changedFiles: FakeGitHubState['changedFiles']) {
  return fakeGitHub({
    changedFiles,
    checkRuns: passing,
    pulls: [{ number: 1, head: { sha: 'abc1234def' } }],
  })
}

describe('complete approval path inventory', () => {
  it('includes both sides of a rename', async () => {
    const { octokit } = github([
      {
        filename: 'README.md',
        status: 'renamed',
        previous_filename: '.github/workflows/build.yml',
      },
    ])
    expect(await getPullRequestChangedPaths(octokit, ref, 1)).toEqual([
      'README.md',
      '.github/workflows/build.yml',
    ])
  })

  it('refuses an incomplete rename record', async () => {
    const { octokit } = github([{ filename: 'README.md', status: 'renamed' }])
    expect(await getPullRequestChangedPaths(octokit, ref, 1)).toBeNull()
  })

  it.each([2999, 3000])(
    'handles the GitHub file cap at %i entries',
    async (count) => {
      const { octokit } = github(
        Array.from({ length: count }, (_, i) => ({ filename: `docs/${i}.md` })),
      )
      const paths = await getPullRequestChangedPaths(octokit, ref, 1)
      if (count === 2999) expect(paths).toHaveLength(count)
      else expect(paths).toBeNull()
    },
  )

  it.each(['.github/workflows/build.yml', 'infra/secret.md'])(
    'cannot approve a rename from %s into docs',
    async (previous_filename) => {
      const { octokit, spy } = github([
        { filename: 'docs/renamed.md', status: 'renamed', previous_filename },
      ])
      await maybeAutoApprove(
        context({
          octokit,
          config: config({
            plugins: { autoApprove: true },
            autoApprove: {
              rules: [
                {
                  name: 'docs',
                  paths: ['**/*.md'],
                  excludePaths: ['infra/**'],
                  requiredContexts: ['Quality / check'],
                },
              ],
            },
          }),
        }),
        1,
        pullRequest(),
      )
      expect(spy.addLabels).not.toHaveBeenCalled()
    },
  )

  it('cannot approve a capped docs prefix hiding further changes', async () => {
    const { octokit, spy } = github(
      Array.from({ length: 3000 }, (_, i) => ({ filename: `docs/${i}.md` })),
    )
    await maybeAutoApprove(
      context({
        octokit,
        config: config({
          plugins: { autoApprove: true },
          autoApprove: { rules: [{ name: 'docs', paths: ['**/*.md'] }] },
        }),
      }),
      1,
      pullRequest(),
    )
    expect(spy.addLabels).not.toHaveBeenCalled()
  })

  it('keeps incomplete inventory out of the full approval and merge pass', async () => {
    const { octokit, spy } = github(
      Array.from({ length: 3000 }, (_, i) => ({ filename: `docs/${i}.md` })),
    )
    await handlePullRequest(
      context({
        octokit,
        config: config({
          plugins: { autoApprove: true, size: false },
          autoApprove: { rules: [{ name: 'docs', paths: ['docs/**'] }] },
        }),
      }),
      1,
      pullRequest(),
    )
    expect(spy.addLabels).not.toHaveBeenCalled()
    expect(spy.merge).not.toHaveBeenCalled()
  })

  it('does not recover or approve Dependabot with an incomplete preloaded inventory', async () => {
    const { octokit, spy } = github([])
    await maybeAutoApproveDependabot(
      context({ octokit, config: config({ plugins: { dependabot: true } }) }),
      1,
      pullRequest({ userLogin: 'dependabot[bot]', mergeable_state: 'behind' }),
      { checkRuns: passing, statuses: [], changedPaths: null },
    )
    expect(spy.addLabels).not.toHaveBeenCalled()
    expect(spy.updateBranch).not.toHaveBeenCalled()
    expect(spy.createComment).not.toHaveBeenCalled()
  })

  it('retains area labels when the path inventory is incomplete', async () => {
    const { octokit, spy } = fakeGitHub({
      changedFiles: [{ filename: 'docs/new.md', status: 'renamed' }],
      labels: { 1: ['area/server'] },
      pulls: [{ number: 1, head: { sha: 'abc1234def' } }],
    })
    await applyAreaLabels(
      context({
        octokit,
        config: config({
          plugins: { area: true },
          area: {
            rules: [{ label: 'area/docs', paths: ['docs/**'] }],
          },
        }),
      }),
      1,
    )
    expect(spy.addLabels).not.toHaveBeenCalled()
    expect(spy.removeLabel).not.toHaveBeenCalled()
  })

  it('still approves an ordinary docs rename with passing checks', async () => {
    const { octokit, spy } = github([
      {
        filename: 'docs/new.md',
        status: 'renamed',
        previous_filename: 'docs/old.md',
      },
    ])
    await maybeAutoApprove(
      context({
        octokit,
        config: config({
          plugins: { autoApprove: true },
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
      1,
      pullRequest(),
    )
    expect(spy.addLabels).toHaveBeenCalledOnce()
  })
})
