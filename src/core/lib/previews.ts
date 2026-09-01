import type {
  BotConfig,
  CheckRun,
  DeploymentStatus,
  PreviewApp,
} from '../types.js'
import { latestCheckRunsByName } from './checks.js'

/**
 * Deployment state comes from a different API than check runs and has its own
 * values, so it is rendered here rather than through the check-state model.
 */
function deploymentIcon(state: string): string {
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

function buildCheckLabel(conclusion: string | null): string {
  if (!conclusion) {
    return '⏳ pending'
  }
  if (conclusion === 'neutral' || conclusion === 'skipped') {
    return `⏭ ${conclusion}`
  }
  return `${deploymentIcon(conclusion)} ${conclusion}`
}

function formatTimestamp(timestamp: string | null): string {
  if (!timestamp) {
    return '—'
  }
  return timestamp.replace(/\.\d{3}Z$/, 'Z').replace('T', ' ')
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
    return `| ${appLink(app, deployment.url)} | ${deploymentIcon(deployment.state)} ${deployment.state} | ${detail || '—'} |`
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

  return `| ${appLink(app, null)} | ${buildCheckLabel(buildCheck.conclusion)} | Build ${buildCheck.conclusion} |`
}

/** The preview section, or nothing when no preview apps are configured. */
export function previewDeploymentSection(input: {
  checkRuns: CheckRun[]
  deployments: DeploymentStatus[]
  config: BotConfig
  deploymentsAvailable: boolean
}): string[] {
  const { checkRuns, deployments, config, deploymentsAvailable } = input

  const previewApps = config.plugins.pipeline ? config.pipeline.previewApps : []
  if (previewApps.length === 0) {
    return []
  }

  const byEnvironment = new Map(
    deployments.map((deployment) => [deployment.environment, deployment]),
  )
  const deployCommandAvailable = Boolean(config.commands.deployWorkflowFile)

  return [
    '',
    '**Preview deployments**',
    '',
    '| App | Status | Detail |',
    '| --- | --- | --- |',
    ...previewApps.map((app) =>
      previewDeployRow(
        app,
        checkRuns,
        byEnvironment.get(app.environment ?? `${app.name} Preview`),
        deploymentsAvailable,
        deployCommandAvailable,
      ),
    ),
    ...(deployCommandAvailable
      ? ['', '_Comment `/deploy` to publish this branch._']
      : []),
  ]
}
