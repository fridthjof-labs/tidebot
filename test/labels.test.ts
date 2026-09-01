import { describe, expect, it, vi } from 'vitest'
import { updatePullRequestBody } from '../src/core/github/pulls.js'
import {
  removeLabelIfPresent,
  setWorkflowLabel,
  syncLabels,
} from '../src/core/lib/labels.js'

const REF = { owner: 'acme', repo: 'widget' }

function octokit(removeLabel: ReturnType<typeof vi.fn>) {
  const addLabels = vi.fn(async () => ({}))
  return {
    client: { rest: { issues: { addLabels, removeLabel } } } as never,
    addLabels,
  }
}

/** Shaped like Octokit's: GitHub's own message, carried on the error. */
function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status })
}

/** What GitHub answers when the issue does not carry the label. */
const labelGone = () => httpError(404, 'Label does not exist')

describe('removeLabelIfPresent', () => {
  /**
   * The observed failure: a run applying `size/m` died on the `size/s` an
   * earlier run had already removed, so the labels never converged.
   */
  it('treats an already-removed label as done', async () => {
    const removeLabel = vi.fn(async () => {
      throw labelGone()
    })

    await expect(
      removeLabelIfPresent(octokit(removeLabel).client, REF, 42, 'size/s'),
    ).resolves.toBeUndefined()
    expect(removeLabel).toHaveBeenCalledOnce()
  })

  it('still surfaces a permission failure', async () => {
    const removeLabel = vi.fn(async () => {
      throw httpError(403, 'Resource not accessible by integration')
    })

    await expect(
      removeLabelIfPresent(octokit(removeLabel).client, REF, 42, 'size/s'),
    ).rejects.toThrow('Resource not accessible by integration')
  })

  /**
   * GitHub answers 404 for a missing issue and an invisible repository too.
   * Swallowing the status code rather than the message would turn a wrong
   * issue number or a lost permission into a silent no-op.
   */
  it('still surfaces a 404 that is not about the label', async () => {
    const removeLabel = vi.fn(async () => {
      throw httpError(404, 'Not Found')
    })

    await expect(
      removeLabelIfPresent(octokit(removeLabel).client, REF, 42, 'size/s'),
    ).rejects.toThrow('Not Found')
  })
})

describe('syncLabels', () => {
  it('applies the new label even when the old one is already gone', async () => {
    const removeLabel = vi.fn(async () => {
      throw labelGone()
    })
    const { client, addLabels } = octokit(removeLabel)

    await syncLabels(client, REF, 42, ['size/s'], ['size/m'], ['size/'])

    expect(addLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ['size/m'] }),
    )
    expect(removeLabel).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'size/s' }),
    )
  })

  it('leaves labels outside the managed prefixes alone', async () => {
    const removeLabel = vi.fn(async () => ({}))

    await syncLabels(
      octokit(removeLabel).client,
      REF,
      42,
      ['size/s', 'lgtm'],
      ['size/m'],
      ['size/'],
    )

    expect(removeLabel).toHaveBeenCalledOnce()
    expect(removeLabel).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'size/s' }),
    )
  })
})

describe('setWorkflowLabel', () => {
  it('does not fail when the label it would remove is gone', async () => {
    const removeLabel = vi.fn(async () => {
      throw labelGone()
    })

    await expect(
      setWorkflowLabel(
        octokit(removeLabel).client,
        REF,
        42,
        ['hold'],
        'hold',
        false,
      ),
    ).resolves.toBeUndefined()
  })
})

describe('updatePullRequestBody', () => {
  function client(update: ReturnType<typeof vi.fn>) {
    return { rest: { pulls: { update } } } as never
  }

  /**
   * A body submitted through GitHub's web form reads back as CRLF, so a body
   * rendered with LF is byte-different while being the same text. Comparing
   * raw would rewrite on every pass — and each write raises
   * `pull_request.edited`, which renders it again.
   */
  it('does not rewrite a body that only differs by line endings', async () => {
    const update = vi.fn(async () => ({ data: {} }))

    const wrote = await updatePullRequestBody(
      client(update),
      REF,
      42,
      'Fixes #1.\n\n> status',
      'Fixes #1.\r\n\r\n> status',
    )

    expect(wrote).toBe(false)
    expect(update).not.toHaveBeenCalled()
  })

  it('writes when the text actually changed', async () => {
    const update = vi.fn(async () => ({ data: {} }))

    const wrote = await updatePullRequestBody(
      client(update),
      REF,
      42,
      'Fixes #1.\n\n> blocked',
      'Fixes #1.\r\n\r\n> ready',
    )

    expect(wrote).toBe(true)
    expect(update).toHaveBeenCalledOnce()
  })
})
