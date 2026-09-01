import type { Octokit } from '@octokit/rest'
import { getFileText } from '../github/contents.js'
import { hasHttpStatus } from '../lib/http.js'
import type { BotConfig, PartialBotConfig, RepoRef } from '../types.js'
import { ConfigError, parsePartialConfig, resolveConfig } from './parse.js'

export const CONFIG_PATHS = ['.github/tidebot.yaml', '.github/tidebot.yml']

/** Repository holding an organisation's shared defaults. */
export const ORG_CONFIG_REPO = '.github'

const CACHE_TTL_MS = 5 * 60 * 1000

type CacheEntry = { config: BotConfig; problems: string[]; expiresAt: number }

const cache = new Map<string, CacheEntry>()

function cacheKey(ref: RepoRef): string {
  return `${ref.owner}/${ref.repo}`
}

/**
 * Drop cached config. Pushing to an owner's `.github` repository invalidates
 * every repository under that owner, not just `.github` itself — the org layer
 * is merged into all of them, so clearing one entry would leave the rest
 * serving the old policy until the TTL expired.
 */
export function invalidateConfigCache(ref?: RepoRef): void {
  if (!ref) {
    cache.clear()
    return
  }

  if (ref.repo === ORG_CONFIG_REPO) {
    const prefix = `${ref.owner}/`
    for (const key of cache.keys()) {
      if (key.startsWith(prefix)) {
        cache.delete(key)
      }
    }
    return
  }

  cache.delete(cacheKey(ref))
}

/** True when a push touched a file that a config layer is read from. */
export function touchesConfig(paths: string[]): boolean {
  return paths.some((path) => CONFIG_PATHS.includes(path))
}

async function readFile(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
): Promise<string | null> {
  try {
    return await getFileText(octokit, { owner, repo }, path)
  } catch (error) {
    // 404 means there is no config, which is a valid state. 403 means we could
    // not tell — treating that as "no config" would silently drop a repository
    // to permissive defaults, so it is surfaced as a problem instead.
    if (hasHttpStatus(error, 404)) {
      return null
    }
    throw error
  }
}

async function readConfigLayer(
  octokit: Octokit,
  owner: string,
  repo: string,
): Promise<{ raw: string; path: string } | null> {
  for (const path of CONFIG_PATHS) {
    const raw = await readFile(octokit, owner, repo, path)
    if (raw !== null) {
      return { raw, path }
    }
  }
  return null
}

export type LoadedConfig = {
  config: BotConfig
  /** Layers that were found, lowest precedence first, for `tidebot doctor`. */
  sources: string[]
  /** Non-fatal problems: a layer that failed to parse is skipped, not fatal. */
  problems: string[]
}

/**
 * Resolve a repository's config from built-in defaults, then the owner's
 * `.github` repository, then the repository itself. A layer that fails to
 * parse is reported and skipped rather than taking the whole installation
 * down — a typo in one repository must not stop the bot everywhere else.
 */
export async function loadRepositoryConfig(
  octokit: Octokit,
  ref: RepoRef,
): Promise<LoadedConfig> {
  const layers: PartialBotConfig[] = []
  const sources: string[] = ['built-in defaults']
  const problems: string[] = []

  // The org layer is skipped when the target *is* the `.github` repository:
  // it would be the same file read twice, and merging a layer over itself
  // would hide a repository-level override behind an identical org one.
  const candidates: Array<{ owner: string; repo: string; label: string }> = [
    ...(ref.repo === ORG_CONFIG_REPO
      ? []
      : [
          {
            owner: ref.owner,
            repo: ORG_CONFIG_REPO,
            label: `${ref.owner}/${ORG_CONFIG_REPO}`,
          },
        ]),
    { owner: ref.owner, repo: ref.repo, label: `${ref.owner}/${ref.repo}` },
  ]

  for (const candidate of candidates) {
    let found: Awaited<ReturnType<typeof readConfigLayer>>
    try {
      found = await readConfigLayer(octokit, candidate.owner, candidate.repo)
    } catch (error) {
      problems.push(
        `${candidate.label} — could not be read: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
      continue
    }

    if (!found) {
      continue
    }

    try {
      layers.push(parsePartialConfig(found.raw))
      sources.push(`${candidate.label}:${found.path}`)
    } catch (error) {
      problems.push(
        `${candidate.label}:${found.path} — ${
          error instanceof ConfigError ? error.message : String(error)
        }`,
      )
    }
  }

  // A layer that failed leaves the merge gate looser than intended, so the
  // resolved config is only usable when every layer resolved. Callers act on
  // `problems`; see handlePullRequest.
  try {
    return { config: resolveConfig(...layers), sources, problems }
  } catch (error) {
    problems.push(
      `resolved config — ${error instanceof ConfigError ? error.message : String(error)}`,
    )
    return { config: resolveConfig(), sources, problems }
  }
}

export async function loadRepositoryConfigCached(
  octokit: Octokit,
  ref: RepoRef,
): Promise<{ config: BotConfig; problems: string[] }> {
  const key = cacheKey(ref)
  const cached = cache.get(key)
  const now = Date.now()
  if (cached && cached.expiresAt > now) {
    return { config: cached.config, problems: cached.problems }
  }

  const { config, problems } = await loadRepositoryConfig(octokit, ref)
  for (const problem of problems) {
    console.error(JSON.stringify({ message: 'tidebot config error', problem }))
  }
  cache.set(key, { config, problems, expiresAt: now + CACHE_TTL_MS })
  return { config, problems }
}
