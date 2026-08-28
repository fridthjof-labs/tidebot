import { parse as parseYaml } from 'yaml'
import { assertPatternIsSafe, GlobError } from '../lib/glob.js'
import type { BotConfig, PartialBotConfig } from '../types.js'
import { DEFAULT_CONFIG } from './defaults.js'
import { deepMerge } from './merge.js'

export class ConfigError extends Error {}

const KNOWN_KEYS = new Set(Object.keys(DEFAULT_CONFIG))

const SECTION_KEYS = {
  plugins: Object.keys(DEFAULT_CONFIG.plugins),
  size: ['thresholds', 'labelPrefix'],
  area: ['rules', 'labelPrefix'],
  commands: [
    'trustedAssociations',
    'updateBranchMethod',
    'deployWorkflowFile',
    'deployInputs',
  ],
  tide: [
    'mergeMethod',
    'requiredLabels',
    'blockedLabels',
    'requiredContexts',
    'autoRebaseWhenBehind',
    'policies',
  ],
  signedRebase: ['workflowFile', 'ref'],
  plan: [...Object.keys(DEFAULT_CONFIG.plan), 'workflowFile'],
  pipeline: ['deployWorkflowName', 'previewApps'],
  stale: Object.keys(DEFAULT_CONFIG.stale),
  dependabot: Object.keys(DEFAULT_CONFIG.dependabot),
  autoApprove: ['rules'],
  intake: Object.keys(DEFAULT_CONFIG.intake),
} satisfies Record<keyof BotConfig, string[]>

const AREA_RULE_KEYS = ['prefix', 'label']
const TIDE_POLICY_KEYS = [
  'name',
  'matchLabels',
  'requiredLabels',
  'requiredContexts',
  'allowSkippedContexts',
  'autoMerge',
]
const PREVIEW_APP_KEYS = ['name', 'environment', 'buildCheck', 'url']
const AUTO_APPROVE_RULE_KEYS = [
  'name',
  'authors',
  'paths',
  'excludePaths',
  'requiredContexts',
  'blockedLabels',
  'maxChangedLines',
]

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

function assertKnownKeys(
  value: unknown,
  path: string,
  knownKeys: string[],
): void {
  if (value === undefined) {
    return
  }
  assert(isRecord(value), `${path} must be a mapping`)
  const known = new Set(knownKeys)
  const unknown = Object.keys(value)
    .filter((key) => !known.has(key))
    .map((key) => `${path}.${key}`)
  assert(
    unknown.length === 0,
    `unknown tidebot config key(s): ${unknown.join(', ')}`,
  )
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

  for (const [section, knownKeys] of Object.entries(SECTION_KEYS)) {
    assertKnownKeys(parsed[section], section, knownKeys)
  }

  assertKnownKeys(config.size?.thresholds, 'size.thresholds', [
    'xs',
    's',
    'm',
    'l',
  ])

  if (Array.isArray(config.area?.rules)) {
    for (const [index, rule] of config.area.rules.entries()) {
      assertKnownKeys(rule, `area.rules[${index}]`, AREA_RULE_KEYS)
    }
  }
  if (Array.isArray(config.tide?.policies)) {
    for (const [index, policy] of config.tide.policies.entries()) {
      assertKnownKeys(policy, `tide.policies[${index}]`, TIDE_POLICY_KEYS)
    }
  }
  if (Array.isArray(config.pipeline?.previewApps)) {
    for (const [index, app] of config.pipeline.previewApps.entries()) {
      assertKnownKeys(app, `pipeline.previewApps[${index}]`, PREVIEW_APP_KEYS)
    }
  }
  if (Array.isArray(config.autoApprove?.rules)) {
    for (const [index, rule] of config.autoApprove.rules.entries()) {
      assertKnownKeys(
        rule,
        `autoApprove.rules[${index}]`,
        AUTO_APPROVE_RULE_KEYS,
      )
    }
  }

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

function typeName(value: unknown): string {
  if (Array.isArray(value)) {
    return 'a list'
  }
  if (value === null) {
    return 'null'
  }
  return typeof value === 'object' ? 'a mapping' : `a ${typeof value}`
}

/**
 * Check the resolved config against the shape of the defaults.
 *
 * The per-key rules above catch the mistakes worth a specific message; this
 * catches the rest generically, because the defaults already state the correct
 * type of every field. It is what stops `requiredContexts: Quality / check`
 * — a string where a list belongs — from reaching the merge gate and throwing
 * at the point of use.
 */
function assertMatchesShape(
  value: unknown,
  expected: unknown,
  path: string,
): void {
  if (Array.isArray(expected)) {
    assert(
      Array.isArray(value),
      `${path} must be a list, got ${typeName(value)}`,
    )
    for (const [index, entry] of (value as unknown[]).entries()) {
      assert(
        typeof entry === 'string' || (isRecord(entry) && !Array.isArray(entry)),
        `${path}[${index}] must be a string or a mapping, got ${typeName(entry)}`,
      )
    }
    return
  }

  if (isRecord(expected)) {
    assert(isRecord(value), `${path} must be a mapping, got ${typeName(value)}`)
    for (const [key, expectedValue] of Object.entries(expected)) {
      if (value[key] !== undefined) {
        assertMatchesShape(value[key], expectedValue, `${path}.${key}`)
      }
    }
    return
  }

  assert(
    typeof value === typeof expected,
    `${path} must be a ${typeof expected}, got ${typeName(value)}`,
  )
}

/** Merge parsed layers over the built-in defaults, lowest precedence first. */
export function resolveConfig(...layers: PartialBotConfig[]): BotConfig {
  const resolved = deepMerge(DEFAULT_CONFIG, ...layers)
  for (const [key, expected] of Object.entries(DEFAULT_CONFIG)) {
    assertMatchesShape(
      (resolved as Record<string, unknown>)[key],
      expected,
      key,
    )
  }
  return resolved
}

export function parseConfig(raw: string): BotConfig {
  return resolveConfig(parsePartialConfig(raw))
}
