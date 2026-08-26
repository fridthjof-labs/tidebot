import { parse as parseYaml } from 'yaml'
import { assertPatternIsSafe, GlobError } from '../lib/glob.js'
import type { BotConfig, PartialBotConfig } from '../types.js'
import { DEFAULT_CONFIG } from './defaults.js'
import { deepMerge } from './merge.js'

export class ConfigError extends Error {}

const KNOWN_KEYS = new Set(Object.keys(DEFAULT_CONFIG))

/**
 * A config layer is written by whoever can land a commit on a default branch,
 * and one instance serves many repositories. These caps keep a mistake in one
 * repository from consuming the whole instance's time or API quota.
 */
const MAX_CONFIG_BYTES = 128 * 1024
const MAX_RULES = 200
const MAX_LIST_ENTRIES = 200
const MAX_SUMMARY_PATTERN_LENGTH = 200
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
  assert(
    raw.length <= MAX_CONFIG_BYTES,
    `tidebot config is larger than ${MAX_CONFIG_BYTES} bytes`,
  )

  // `yaml`'s default settings resolve no custom tags and cap alias expansion,
  // so a hostile document cannot construct objects or blow up in size here.
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

  assert(
    (config.area?.rules?.length ?? 0) <= MAX_RULES,
    `area.rules has more than ${MAX_RULES} entries`,
  )
  for (const rule of config.area?.rules ?? []) {
    assert(
      typeof rule?.prefix === 'string' && typeof rule?.label === 'string',
      'each area.rules entry needs a string prefix and label',
    )
  }

  assert(
    (config.autoApprove?.rules?.length ?? 0) <= MAX_RULES,
    `autoApprove.rules has more than ${MAX_RULES} entries`,
  )
  for (const rule of config.autoApprove?.rules ?? []) {
    assert(
      typeof rule?.name === 'string' && rule.name.length > 0,
      'each autoApprove.rules entry needs a name',
    )
    assert(
      (rule.authors?.length ?? 0) > 0 || (rule.paths?.length ?? 0) > 0,
      `autoApprove rule "${rule.name}" must constrain authors or paths — an unconstrained rule would approve every pull request`,
    )
    assert(
      (rule.paths?.length ?? 0) + (rule.excludePaths?.length ?? 0) <=
        MAX_LIST_ENTRIES,
      `autoApprove rule "${rule.name}" lists more than ${MAX_LIST_ENTRIES} paths`,
    )
    // Compiling every pattern now turns a pathological glob into a config
    // error on one repository, rather than a hang on the next event.
    for (const pattern of [
      ...(rule.paths ?? []),
      ...(rule.excludePaths ?? []),
    ]) {
      try {
        assertPatternIsSafe(pattern)
      } catch (error) {
        throw new ConfigError(
          error instanceof GlobError ? error.message : String(error),
        )
      }
    }
  }

  if (config.plan?.summaryPattern !== undefined) {
    assert(
      config.plan.summaryPattern.length <= MAX_SUMMARY_PATTERN_LENGTH,
      `plan.summaryPattern is longer than ${MAX_SUMMARY_PATTERN_LENGTH} characters`,
    )
    try {
      new RegExp(config.plan.summaryPattern)
    } catch {
      assert(false, 'plan.summaryPattern is not a valid regular expression')
    }
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
