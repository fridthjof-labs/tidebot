import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  invalidateConfigCache,
  loadRepositoryConfig,
  loadRepositoryConfigCached,
  touchesConfig,
} from '../src/core/config/load.js'

function encode(yaml: string): string {
  return Buffer.from(yaml, 'utf8').toString('base64')
}

function octokitReturning(files: Record<string, string>) {
  const getContent = vi.fn(async ({ owner, repo, path }) => {
    const key = `${owner}/${repo}:${path}`
    if (!(key in files)) {
      throw Object.assign(new Error('Not Found'), { status: 404 })
    }
    return { data: { type: 'file', content: encode(files[key]) } }
  })
  return { octokit: { rest: { repos: { getContent } } } as never, getContent }
}

const REF = { owner: 'acme', repo: 'widget' }

beforeEach(() => {
  invalidateConfigCache()
})

describe('loadRepositoryConfig', () => {
  it('falls back to defaults when nothing is configured', async () => {
    const { octokit } = octokitReturning({})
    const loaded = await loadRepositoryConfig(octokit, REF)
    expect(loaded.sources).toEqual(['built-in defaults'])
    expect(loaded.config.tide.mergeMethod).toBe('squash')
  })

  it('layers the repository file over the org .github file', async () => {
    const { octokit } = octokitReturning({
      'acme/.github:.github/tidebot.yaml':
        'tide:\n  mergeMethod: merge\nstale:\n  daysUntilStale: 30',
      'acme/widget:.github/tidebot.yaml': 'tide:\n  mergeMethod: squash',
    })

    const loaded = await loadRepositoryConfig(octokit, REF)
    expect(loaded.config.tide.mergeMethod).toBe('squash')
    expect(loaded.config.stale.daysUntilStale).toBe(30)
    expect(loaded.sources).toEqual([
      'built-in defaults',
      'acme/.github:.github/tidebot.yaml',
      'acme/widget:.github/tidebot.yaml',
    ])
  })

  it('accepts the .yml spelling', async () => {
    const { octokit } = octokitReturning({
      'acme/widget:.github/tidebot.yml': 'plugins:\n  stale: true',
    })
    const loaded = await loadRepositoryConfig(octokit, REF)
    expect(loaded.config.plugins.stale).toBe(true)
  })

  it('skips a broken layer instead of failing the whole event', async () => {
    const { octokit } = octokitReturning({
      'acme/widget:.github/tidebot.yaml': 'nonsense_key: true',
    })
    const loaded = await loadRepositoryConfig(octokit, REF)
    expect(loaded.problems).toHaveLength(1)
    expect(loaded.config.tide.mergeMethod).toBe('squash')
  })

  it('does not read the .github repo as its own org layer twice', async () => {
    const { octokit, getContent } = octokitReturning({
      'acme/.github:.github/tidebot.yaml': 'plugins:\n  stale: true',
    })
    await loadRepositoryConfig(octokit, { owner: 'acme', repo: '.github' })
    const paths = getContent.mock.calls.map((call) => call[0].repo)
    expect(paths.filter((repo) => repo === '.github')).toHaveLength(1)
  })
})

describe('config cache', () => {
  it('reuses a resolved config until it is invalidated', async () => {
    const { octokit, getContent } = octokitReturning({
      'acme/widget:.github/tidebot.yaml': 'plugins:\n  stale: true',
    })

    await loadRepositoryConfigCached(octokit, REF)
    await loadRepositoryConfigCached(octokit, REF)
    const callsAfterCache = getContent.mock.calls.length

    invalidateConfigCache(REF)
    await loadRepositoryConfigCached(octokit, REF)
    expect(getContent.mock.calls.length).toBeGreaterThan(callsAfterCache)
  })
})

describe('touchesConfig', () => {
  it('recognises a pushed config change', () => {
    expect(touchesConfig(['src/index.ts', '.github/tidebot.yaml'])).toBe(true)
    expect(touchesConfig(['src/index.ts'])).toBe(false)
  })
})
