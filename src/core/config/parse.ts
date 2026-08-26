import { parse as parseYaml } from 'yaml'
import type { BotConfig, PartialBotConfig } from '../types.js'
import { DEFAULT_CONFIG } from './defaults.js'
import { deepMerge } from './merge.js'

export class ConfigError extends Error {}

const KNOWN_KEYS = new Set(Object.keys(DEFAULT_CONFIG))
const MERGE_METHODS = new Set(['merge', 'squash', 'rebase'])
const UPDATE_BRANCH_METHODS = new Set(['merge', 'rebase', 'signed-rebase'])

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new ConfigError(message)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parse one config layer. Validation is deliberately shallow-but-strict: it
 * rejects the mistakes that would otherwise fail silently at merge time
 * (a misspelled top-level key, a merge method GitHub will refuse, an area
 * rule missing its label) without re-describing every field.
 */
export function parsePartialConfig(raw: string): PartialBotConfig {
  const parsed: unknown = raw.trim() ? parseYaml(raw) : {}
  if (parsed === null || parsed === undefined) {
    return {}
  }
  assert(isRecord(parsed), 'tidebot config must be a YAML mapping')

  const unknown = Object.keys(parsed).filter((key) => !KNOWN_KEYS.has(key))
  assert(
    unknown.length === 0,
    `unknown tidebot config key(s): ${unknown.join(', ')}`,
  )

  const config = parsed as PartialBotConfig

  if (config.tide?.mergeMethod !== undefined) {
    assert(
      MERGE_METHODS.has(config.tide.mergeMethod),
      `tide.mergeMethod must be one of ${[...MERGE_METHODS].join(', ')}`,
    )
  }

  if (config.commands?.updateBranchMethod !== undefined) {
    assert(
      UPDATE_BRANCH_METHODS.has(config.commands.updateBranchMethod),
      `commands.updateBranchMethod must be one of ${[...UPDATE_BRANCH_METHODS].join(', ')}`,
    )
  }

  for (const rule of config.area?.rules ?? []) {
    assert(
      typeof rule?.prefix === 'string' && typeof rule?.label === 'string',
      'each area.rules entry needs a string prefix and label',
    )
  }

  for (const rule of config.autoApprove?.rules ?? []) {
    assert(
      typeof rule?.name === 'string' && rule.name.length > 0,
      'each autoApprove.rules entry needs a name',
    )
    assert(
      (rule.authors?.length ?? 0) > 0 || (rule.paths?.length ?? 0) > 0,
      `autoApprove rule "${rule.name}" must constrain authors or paths — an unconstrained rule would approve every pull request`,
    )
  }

  for (const policy of config.tide?.policies ?? []) {
    assert(
      Array.isArray(policy?.matchLabels) && policy.matchLabels.length > 0,
      'each tide.policies entry needs a non-empty matchLabels list',
    )
  }

  return config
}

/** Merge parsed layers over the built-in defaults, lowest precedence first. */
export function resolveConfig(...layers: PartialBotConfig[]): BotConfig {
  return deepMerge(DEFAULT_CONFIG, ...layers)
}

export function parseConfig(raw: string): BotConfig {
  return resolveConfig(parsePartialConfig(raw))
}
