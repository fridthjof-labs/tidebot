import type { BotConfig } from '../types.js'

/**
 * What Tidebot does in a repository that has no `.github/tidebot.yaml` at all:
 * size and area labels, slash commands, and Tide auto-merge behind
 * `lgtm` + `approved`. Everything that needs repository-specific knowledge —
 * required checks, area rules, plan and deploy workflows, preview apps — stays
 * off until it is configured, so an install can never merge on a check set the
 * repository never declared.
 */
export const DEFAULT_CONFIG: BotConfig = {
  plugins: {
    size: true,
    area: true,
    commands: true,
    tide: true,
    stale: false,
    dependabot: false,
    autoApprove: false,
    plan: false,
    pipeline: false,
    intake: true,
  },
  size: {
    thresholds: { xs: 10, s: 50, m: 200, l: 500 },
    labelPrefix: 'size/',
  },
  area: {
    rules: [],
    labelPrefix: 'area/',
  },
  commands: {
    trustedAssociations: ['MEMBER', 'OWNER', 'COLLABORATOR'],
    updateBranchMethod: 'merge',
  },
  tide: {
    mergeMethod: 'squash',
    requiredLabels: ['lgtm', 'approved'],
    blockedLabels: ['hold'],
    requiredContexts: [],
    autoRebaseWhenBehind: true,
    policies: [],
  },
  signedRebase: {
    workflowFile: 'tidebot-rebase.yml',
  },
  plan: {
    workflowName: 'Infrastructure',
    planJobName: 'plan',
    logBeginMarker: 'TIDEBOT_PLAN_LOG_BEGIN',
    logEndMarker: 'TIDEBOT_PLAN_LOG_END',
    actionsMarker: 'will perform the following actions:',
    noChangesMarker: 'No changes.',
    summaryPattern:
      'Plan:\\s*(\\d+)\\s+to add,\\s*(\\d+)\\s+to change,\\s*(\\d+)\\s+to destroy',
    codeFence: 'hcl',
    heading: 'Infrastructure plan',
  },
  pipeline: {
    previewApps: [],
  },
  stale: {
    daysUntilStale: 14,
    daysUntilClose: 7,
    staleLabel: 'stale',
    exemptLabels: ['hold', 'pinned', 'dependencies'],
  },
  dependabot: {
    enabled: false,
    autoApprove: false,
    requiredContexts: [],
    allowMajorUpdates: false,
    requireDependenciesLabel: true,
    allowedPathPrefixes: [
      'package.json',
      'package-lock.json',
      'pnpm-lock.yaml',
      'yarn.lock',
      'go.mod',
      'go.sum',
      'Cargo.toml',
      'Cargo.lock',
      'requirements.txt',
      'pyproject.toml',
      'uv.lock',
      '.github/',
    ],
  },
  autoApprove: {
    rules: [],
  },
  intake: {
    bugLabels: ['bug'],
    featureLabels: ['enhancement'],
  },
}

/** Labels Tidebot needs to exist in a repository for its own rules to work. */
export function managedLabels(config: BotConfig): Array<{
  name: string
  color: string
  description: string
}> {
  const sizes = ['xs', 's', 'm', 'l', 'xl']
  const sizeColors = ['c2e0c6', 'bfd4f2', 'fbca04', 'e99695', 'b60205']

  return [
    {
      name: 'lgtm',
      color: '0e8a16',
      description: 'Reviewed and looks good — half of the Tide merge gate',
    },
    {
      name: 'approved',
      color: '0e8a16',
      description: 'Approved to merge — half of the Tide merge gate',
    },
    {
      name: 'hold',
      color: 'b60205',
      description: 'Blocks auto-merge until removed with /unhold',
    },
    {
      name: config.stale.staleLabel,
      color: 'ededed',
      description: 'No activity for long enough to be swept',
    },
    ...sizes.map((size, index) => ({
      name: `${config.size.labelPrefix}${size}`,
      color: sizeColors[index],
      description: `Pull request diff size: ${size}`,
    })),
    ...config.area.rules.map((rule) => ({
      name: rule.label,
      color: '1d76db',
      description: `Changes under ${rule.prefix}`,
    })),
  ]
}
