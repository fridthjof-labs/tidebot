import type {
  BotConfig,
  CheckRun,
  DeploymentStatus,
  PreviewApp,
} from '../types.js'
import { checkState, conclusionWord, stateIcon } from './check-view.js'
import { latestCheckRunsByName } from './checks.js'
import { GLYPH } from './glyphs.js'

/**
 * Deployment state is its own vocabulary from its own API, so it maps onto the
 * shared glyphs here. Check runs do not come through this function: a build
 * check is a check run and is rendered by `check-view`, or the same conclusion
 * would show one symbol in the preview table and another in the check table.
 */
function deploymentIcon(state: string): string {
  switch (state) {
    case 'success':
      return GLYPH.passed
    case 'failure':
    case 'error':
      return GLYPH.failed
    case 'pending':
    case 'in_progress':
    case 'queued':
      return GLYPH.running
    case 'inactive':
      return GLYPH.skipped
    default:
      return GLYPH.unknown
  }
}

function formatTimestamp(timestamp: string | null): string {
  if (!timestamp) {
    return GLYPH.none
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
    return `| ${appLink(app, deployment.url)} | ${deploymentIcon(deployment.state)} ${deployment.state} | ${detail || GLYPH.none} |`
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

  const word = conclusionWord(buildCheck.conclusion)
  return `| ${appLink(app, null)} | ${stateIcon(checkState(buildCheck))} ${word} | Build ${word} |`
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
