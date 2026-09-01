import { describe, expect, it } from 'vitest'
import { dismissStaleMergeLabels } from '../src/core/plugins/dismiss.js'
import { fakeGitHub } from './fake-github.js'
import { config, context, pullRequest } from './helpers.js'

const LABELLED = pullRequest({
  labels: [{ name: 'lgtm' }, { name: 'approved' }, { name: 'size/s' }],
  head: { sha: 'new', ref: 'feature', repoFullName: 'acme/widget' },
})

function octokit(
  files: Record<string, Array<{ filename: string; patch: string }>>,
) {
  const { octokit: client, spy } = fakeGitHub({
    compare: files,
    // The pull request really carries them, so a removal that GitHub would
    // reject as absent shows up as one here too.
    labels: { 42: ['lgtm', 'approved', 'size/s'] },
  })
  return { client, removeLabel: spy.removeLabel, compare: spy.compare }
}

const SAME = [{ filename: 'a.ts', patch: '@@ -1 +1 @@' }]
const DIFFERENT = [{ filename: 'a.ts', patch: '@@ -1 +2 @@' }]

describe('dismissStaleMergeLabels', () => {
  it('withdraws the review labels when the push changed the diff', async () => {
    const { client, removeLabel } = octokit({ old: SAME, new: DIFFERENT })

    const dismissed = await dismissStaleMergeLabels(
      context({ octokit: client }),
      42,
      LABELLED,
      { before: 'old', after: 'new' },
    )

    expect(dismissed).toEqual(['lgtm', 'approved'])
    expect(removeLabel).toHaveBeenCalledTimes(2)
    // Labels Tidebot did not put there for review reasons stay put.
    expect(removeLabel).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'size/s' }),
    )
  })

  /**
   * `autoRebaseWhenBehind` moves the head of pull requests that already carry
   * full merge intent. Dismissing there would make Tidebot undo its own work.
   */
  it('keeps them when the push only moved the branch onto its base', async () => {
    const { client, removeLabel } = octokit({ old: SAME, new: SAME })

    const dismissed = await dismissStaleMergeLabels(
      context({ octokit: client }),
      42,
      LABELLED,
      { before: 'old', after: 'new' },
    )

    expect(dismissed).toEqual([])
    expect(removeLabel).not.toHaveBeenCalled()
  })

  it('costs no API call when there is nothing to withdraw', async () => {
    const { client, compare, removeLabel } = octokit({})

    const dismissed = await dismissStaleMergeLabels(
      context({ octokit: client }),
      42,
      pullRequest({ labels: [{ name: 'size/s' }] }),
      { before: 'old', after: 'new' },
    )

    expect(dismissed).toEqual([])
    expect(compare).not.toHaveBeenCalled()
    expect(removeLabel).not.toHaveBeenCalled()
  })

  /** Failing open would keep an approval on a push nobody could inspect. */
  it('withdraws them when the comparison cannot be read', async () => {
    const { client, removeLabel } = octokit({ new: DIFFERENT })

    const dismissed = await dismissStaleMergeLabels(
      context({ octokit: client }),
      42,
      LABELLED,
      { before: 'gone', after: 'new' },
    )

    expect(dismissed).toEqual(['lgtm', 'approved'])
    expect(removeLabel).toHaveBeenCalledTimes(2)
  })

  /**
   * GitHub caps a comparison at 300 files. Past that the list is a prefix, and
   * two different pushes can share one — which would read as "unchanged" and
   * keep a review the new code never had.
   */
  it('refuses to answer from a truncated comparison', async () => {
    const wide = Array.from({ length: 300 }, (_, i) => ({
      filename: `f${i}.ts`,
      patch: '@@ -1 +1 @@',
    }))
    const { client, removeLabel } = octokit({ old: wide, new: wide })

    const dismissed = await dismissStaleMergeLabels(
      context({ octokit: client }),
      42,
      LABELLED,
      { before: 'old', after: 'new' },
    )

    expect(dismissed).toEqual(['lgtm', 'approved'])
    expect(removeLabel).toHaveBeenCalledTimes(2)
  })

  it('does nothing when the feature is configured off', async () => {
    const { client, compare } = octokit({ old: SAME, new: DIFFERENT })

    const dismissed = await dismissStaleMergeLabels(
      context({
        octokit: client,
        config: config({ tide: { dismissLabelsOnPush: [] } }),
      }),
      42,
      LABELLED,
      { before: 'old', after: 'new' },
    )

    expect(dismissed).toEqual([])
    expect(compare).not.toHaveBeenCalled()
  })
})
