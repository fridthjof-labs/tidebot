import type {
  BotConfig,
  CheckRun,
  DeploymentStatus,
  PreviewApp,
  PullRequest,
  TideDecision,
} from '../types.js'
import { latestCheckRunsByName } from './checks.js'
import {
  PIPELINE_COMMENT_MARKER,
  PLAN_SECTION_BEGIN,
  PLAN_SECTION_END,
} from './markers.js'

const ATTENTION_CHECK_CONCLUSIONS = new Set([
  'failure',
  'error',
  'cancelled',
  'timed_out',
  'action_required',
])

function statusIcon(state: string): string {
  switch (state) {
    case 'success':
      return '✅'
    case 'failure':
    case 'error':
      return '❌'
    case 'pending':
    case 'in_progress':
    case 'queued':
      return '⏳'
    case 'inactive':
      return '⏭'
    default:
      return '⚪'
  }
}

function checkConclusionLabel(conclusion: string | null): string {
  if (!conclusion) {
    return '⏳ pending'
  }
  if (conclusion === 'neutral' || conclusion === 'skipped') {
    return `⏭ ${conclusion}`
  }
  return `${statusIcon(conclusion)} ${conclusion}`
}

function formatTimestamp(timestamp: string | null): string {
  if (!timestamp) {
    return '—'
  }
  return timestamp.replace(/\.\d{3}Z$/, 'Z').replace('T', ' ')
}

function checkRunSummary(checkRuns: CheckRun[]): string {
  const latest = [...latestCheckRunsByName(checkRuns).values()]
  if (latest.length === 0) {
    return 'No CI checks reported yet.'
  }

  const failed = latest.filter(
    (run) =>
      run.conclusion === 'failure' ||
      run.conclusion === 'error' ||
      run.conclusion === 'cancelled',
  ).length
  const pending = latest.filter((run) => !run.conclusion).length
  const passed = latest.filter(
    (run) =>
      run.conclusion === 'success' ||
      run.conclusion === 'neutral' ||
      run.conclusion === 'skipped',
  ).length

  return `${passed}/${latest.length} green${pending ? `, ${pending} pending` : ''}${failed ? `, ${failed} failing` : ''}.`
}

function appLink(app: PreviewApp, url: string | null | undefined): string {
  const target = url ?? app.url
  return target ? `[${app.name}](${target})` : app.name
}

function previewDeployRow(
  app: PreviewApp,
  checkRuns: CheckRun[],
  deployment: DeploymentStatus | undefined,
  deploymentsAvailable: boolean,
  deployCommandAvailable: boolean,
): string {
  if (!deploymentsAvailable) {
    return `| ${app.name} | ⚪ unavailable | GitHub deployments API unavailable |`
  }

  if (deployment) {
    const detail = [
      deployment.description,
      deployment.updatedAt
        ? `updated ${formatTimestamp(deployment.updatedAt)}`
        : null,
    ]
      .filter(Boolean)
      .join('; ')
    return `| ${appLink(app, deployment.url)} | ${statusIcon(deployment.state)} ${deployment.state} | ${detail || '—'} |`
  }

  const buildCheck = app.buildCheck
    ? (latestCheckRunsByName(checkRuns).get(app.buildCheck) ?? null)
    : null

  if (!buildCheck) {
    return `| ${appLink(app, null)} | ⚪ no deployment | Nothing reported for this commit |`
  }
  if (buildCheck.conclusion === 'skipped') {
    return `| ${appLink(app, null)} | ⏭ skipped | No relevant file changes on this PR |`
  }
  if (!buildCheck.conclusion) {
    return `| ${appLink(app, null)} | ⏳ pending | Waiting for CI build |`
  }
  if (buildCheck.conclusion === 'success') {
    const hint = deployCommandAvailable
      ? 'Run `/deploy` to publish this branch'
      : 'Build green; no deployment reported yet'
    return `| ${appLink(app, null)} | ⏳ pending | ${hint} |`
  }

  return `| ${appLink(app, null)} | ${checkConclusionLabel(buildCheck.conclusion)} | Build ${buildCheck.conclusion} |`
}

export type LabelCommandOutcome = {
  kind: 'label'
  label: string
  action: 'applied' | 'removed'
}

export type RetestCommandOutcome = { kind: 'retest' }

export type RebaseCommandOutcome = {
  kind: 'rebase'
  updated: boolean
  message: string
}

export type PlanCommandOutcome = {
  kind: 'plan'
  dispatched: boolean
  message: string
}

export type DeployCommandOutcome = {
  kind: 'deploy'
  dispatched: boolean
  message: string
}

export type UnavailableCommandOutcome = {
  kind: 'unavailable'
  command: string
  message: string
}

export type CommandOutcome =
  | LabelCommandOutcome
  | RetestCommandOutcome
  | RebaseCommandOutcome
  | PlanCommandOutcome
  | DeployCommandOutcome
  | UnavailableCommandOutcome

export function formatCommandReply(
  userLogin: string,
  outcomes: CommandOutcome[],
): string {
  const lines: string[] = []

  for (const outcome of outcomes) {
    if (outcome.kind === 'retest') {
      lines.push(
        'Re-run CI from the PR checks tab, or push an empty commit:\n\n```bash\ngit commit --allow-empty -m "retest" && git push\n```',
      )
    }
    if (outcome.kind === 'rebase') {
      const prefix = outcome.updated
        ? 'Updating branch onto base.'
        : 'Branch update failed.'
      lines.push(`@${userLogin} ${prefix} ${outcome.message}`)
    }
    if (outcome.kind === 'plan' || outcome.kind === 'deploy') {
      const noun = outcome.kind === 'plan' ? 'Plan' : 'Deploy'
      const prefix = outcome.dispatched
        ? `${noun} workflow queued.`
        : `${noun} workflow dispatch failed.`
      lines.push(`@${userLogin} ${prefix} ${outcome.message}`)
    }
    if (outcome.kind === 'unavailable') {
      lines.push(`@${userLogin} \`/${outcome.command}\` ${outcome.message}`)
    }
  }

  return lines.join('\n\n')
}

/**
 * One upserted comment per pull request carrying preview deployments, CI
 * status, an optional plan section, and the merge gate. Sections whose config
 * is empty are omitted rather than rendered blank.
 */
export function formatPipelineSummary(input: {
  checkRuns: CheckRun[]
  deployments: DeploymentStatus[]
  tide: TideDecision
  pr: PullRequest
  config: BotConfig
  deploymentsAvailable?: boolean
  planSection?: string | null
}): string {
  const {
    checkRuns,
    deployments,
    tide,
    pr,
    config,
    deploymentsAvailable = true,
    planSection = null,
  } = input

  const attentionRows = [...latestCheckRunsByName(checkRuns).values()]
    .filter(
      (run) =>
        !run.conclusion || ATTENTION_CHECK_CONCLUSIONS.has(run.conclusion),
    )
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((run) => `| ${run.name} | ${checkConclusionLabel(run.conclusion)} |`)

  const deployByEnvironment = new Map(
    deployments.map((deployment) => [deployment.environment, deployment]),
  )
  const previewApps = config.plugins.pipeline ? config.pipeline.previewApps : []
  const deployCommandAvailable = Boolean(config.commands.deployWorkflowFile)
  const deployRows = previewApps.map((app) =>
    previewDeployRow(
      app,
      checkRuns,
      deployByEnvironment.get(app.environment ?? `${app.name} Preview`),
      deploymentsAvailable,
      deployCommandAvailable,
    ),
  )

  const labelNames = pr.labels
    .map((label) => label.name)
    .filter((name): name is string => Boolean(name))
  const tideStatus = tide.ready
    ? '✅ ready to merge'
    : `⏸ blocked — ${tide.reasons.join('; ')}`

  return [
    PIPELINE_COMMENT_MARKER,
    '### Pipeline status',
    '',
    `\`${pr.head.sha.slice(0, 7)}\``,
    ...(deployRows.length > 0
      ? [
          '',
          '**🚀 Preview deployments**',
          '| App | Status | Detail |',
          '| --- | --- | --- |',
          ...deployRows,
          ...(deployCommandAvailable
            ? ['', '_Comment `/deploy` to publish this branch._']
            : []),
        ]
      : []),
    '',
    '**🔍 CI checks**',
    checkRunSummary(checkRuns),
    ...(attentionRows.length > 0
      ? ['', '| Check | Status |', '| --- | --- |', ...attentionRows]
      : []),
    ...(planSection
      ? [
          '',
          `### 🏗️ ${config.plan.heading}`,
          '',
          PLAN_SECTION_BEGIN,
          planSection,
          PLAN_SECTION_END,
        ]
      : []),
    '',
    '**🌊 Merge gate**',
    '| | |',
    '| --- | --- |',
    `| Labels | ${labelNames.map((name) => `\`${name}\``).join(', ') || '—'} |`,
    `| Merge | ${tideStatus} |`,
  ].join('\n')
}

export function extractPlanSection(
  body: string | null | undefined,
): string | null {
  if (!body) {
    return null
  }
  const begin = body.indexOf(PLAN_SECTION_BEGIN)
  if (begin === -1) {
    return null
  }
  const end = body.indexOf(PLAN_SECTION_END, begin)
  if (end === -1) {
    return null
  }
  const trimmed = body.slice(begin + PLAN_SECTION_BEGIN.length, end).trim()
  return trimmed.length > 0 ? trimmed : null
}
