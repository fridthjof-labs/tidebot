import { describe, expect, it } from 'vitest'
import { parseRepositoryFullName, toPullRequest } from '../src/core/webhooks.js'

describe('parseRepositoryFullName', () => {
  it('splits owner and repo', () => {
    expect(parseRepositoryFullName('acme/widget')).toEqual({
      owner: 'acme',
      repo: 'widget',
    })
  })

  it('rejects a malformed name', () => {
    expect(() => parseRepositoryFullName('widget')).toThrow(
      /Invalid repository/,
    )
  })
})

describe('toPullRequest', () => {
  it('carries the head repo so fork checks can run', () => {
    const pr = toPullRequest({
      node_id: 'PR_1',
      state: 'open',
      labels: [{ name: 'lgtm' }],
      base: { ref: 'main' },
      head: { sha: 'abc', ref: 'feature', repo: { full_name: 'fork/widget' } },
      user: { login: 'someone' },
    })
    expect(pr.head.repoFullName).toBe('fork/widget')
    expect(pr.base?.ref).toBe('main')
    expect(pr.additions).toBe(0)
  })
})
