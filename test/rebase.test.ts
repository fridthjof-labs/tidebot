import { describe, expect, it, vi } from 'vitest'
import { isForkPullRequest, updateBranch } from '../src/core/lib/rebase.js'
import { config, pullRequest } from './helpers.js'

const REF = { owner: 'acme', repo: 'widget' }

describe('updateBranch', () => {
  it('uses the update-branch API for the merge method', async () => {
    const updateBranchApi = vi.fn().mockResolvedValue({ data: {}, status: 202 })
    const result = await updateBranch(
      { rest: { pulls: { updateBranch: updateBranchApi } } } as never,
      REF,
      7,
      pullRequest(),
      config(),
      'main',
    )
    expect(result.updated).toBe(true)
    expect(updateBranchApi).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'widget',
      pull_number: 7,
    })
  })

  it('dispatches the signing workflow for signed-rebase', async () => {
    const createWorkflowDispatch = vi.fn().mockResolvedValue({})
    const result = await updateBranch(
      { rest: { actions: { createWorkflowDispatch } } } as never,
      REF,
      7,
      pullRequest(),
      config({ commands: { updateBranchMethod: 'signed-rebase' } }),
      'main',
    )

    expect(result.updated).toBe(true)
    expect(createWorkflowDispatch).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'widget',
      workflow_id: 'tidebot-rebase.yml',
      ref: 'main',
      inputs: { pull_number: '7' },
    })
  })

  it('refuses a signed rebase on a fork instead of failing in the runner', async () => {
    const createWorkflowDispatch = vi.fn()
    const result = await updateBranch(
      { rest: { actions: { createWorkflowDispatch } } } as never,
      REF,
      7,
      pullRequest({
        head: {
          sha: 'abc',
          ref: 'feature',
          repoFullName: 'contributor/widget',
        },
      }),
      config({ commands: { updateBranchMethod: 'signed-rebase' } }),
      'main',
    )

    expect(result.updated).toBe(false)
    expect(result.message).toMatch(/fork/)
    expect(createWorkflowDispatch).not.toHaveBeenCalled()
  })

  it('starts the workflow with the dispatch client, not the push App', async () => {
    // The push App has no Actions permission; the bot's own token dispatches.
    const appDispatch = vi.fn().mockResolvedValue({})
    const ownDispatch = vi.fn().mockResolvedValue({})
    const result = await updateBranch(
      { rest: { actions: { createWorkflowDispatch: appDispatch } } } as never,
      REF,
      7,
      pullRequest(),
      config({ commands: { updateBranchMethod: 'signed-rebase' } }),
      'main',
      { rest: { actions: { createWorkflowDispatch: ownDispatch } } } as never,
    )

    expect(result.updated).toBe(true)
    expect(ownDispatch).toHaveBeenCalledTimes(1)
    expect(appDispatch).not.toHaveBeenCalled()
  })

  it('reports a missing workflow rather than claiming success', async () => {
    const createWorkflowDispatch = vi
      .fn()
      .mockRejectedValue(new Error('Not Found'))
    const result = await updateBranch(
      { rest: { actions: { createWorkflowDispatch } } } as never,
      REF,
      7,
      pullRequest(),
      config({ commands: { updateBranchMethod: 'signed-rebase' } }),
      'main',
    )
    expect(result.updated).toBe(false)
    expect(result.message).toMatch(/tidebot-rebase\.yml/)
  })
})

describe('isForkPullRequest', () => {
  it('is false when the head repo is the same repo', () => {
    expect(isForkPullRequest(pullRequest(), REF)).toBe(false)
  })

  it('is false when GitHub did not report a head repo', () => {
    expect(
      isForkPullRequest(
        pullRequest({ head: { sha: 'a', ref: 'b', repoFullName: null } }),
        REF,
      ),
    ).toBe(false)
  })
})
