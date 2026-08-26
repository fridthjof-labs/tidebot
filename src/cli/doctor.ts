import type { Octokit } from '@octokit/rest'
import { managedLabels } from '../core/config/defaults.js'
import { loadRepositoryConfig } from '../core/config/load.js'
import type { BotConfig, RepoRef } from '../core/types.js'

export type Finding = {
  level: 'ok' | 'warn' | 'error'
  message: string
}

const REQUIRED_PERMISSIONS: Array<[string, string]> = [
  ['pull_requests', 'write'],
  ['contents', 'write'],
  ['issues', 'write'],
  ['checks', 'read'],
  ['statuses', 'read'],
  ['metadata', 'read'],
]

const REQUIRED_EVENTS = [
  'issue_comment',
  'pull_request',
  'pull_request_review',
  'push',
  'check_suite',
]

function satisfies(actual: string | undefined, needed: string): boolean {
  if (!actual) {
    return false
  }
  return needed === 'read'
    ? actual === 'read' || actual === 'write'
    : actual === 'write'
}

/**
 * Explain why an installation is not behaving, before it silently does
 * nothing. Every check maps to a real failure seen in practice: a missing
 * permission that turns auto-merge into "Resource not accessible", an
 * unsubscribed event that makes slash commands vanish, or a label a rule names
 * but the repository does not have.
 */
export async function diagnose(
  octokit: Octokit,
  ref: RepoRef,
  options: {
    installation?: {
      permissions?: Record<string, string>
      events?: string[]
    }
    /** Present when running with App credentials. */
    appEvents?: string[]
  } = {},
): Promise<{ findings: Finding[]; config: BotConfig }> {
  const findings: Finding[] = []

  const { config, sources, problems } = await loadRepositoryConfig(octokit, ref)
  findings.push({
    level: 'ok',
    message: `Config layers: ${sources.join(' → ')}`,
  })
  for (const problem of problems) {
    findings.push({ level: 'error', message: `Config error in ${problem}` })
  }
  if (sources.length === 1) {
    findings.push({
      level: 'warn',
      message:
        'No .github/tidebot.yaml found; running on built-in defaults. Run `tidebot init` in the repository.',
    })
  }

  const permissions = options.installation?.permissions
  if (permissions) {
    for (const [name, needed] of REQUIRED_PERMISSIONS) {
      if (!satisfies(permissions[name], needed)) {
        findings.push({
          level: 'error',
          message: `Installation is missing ${name}: ${needed} (has ${permissions[name] ?? 'none'})`,
        })
      }
    }
  }

  const events = options.appEvents ?? options.installation?.events
  if (events) {
    for (const event of REQUIRED_EVENTS) {
      if (!events.includes(event)) {
        findings.push({
          level: 'error',
          message: `App is not subscribed to the ${event} event`,
        })
      }
    }
    if (events.includes('status')) {
      findings.push({
        level: 'warn',
        message:
          'App is subscribed to `status`; it duplicates check_suite and can exhaust the installation rate limit.',
      })
    }
  }

  const existingLabels = new Set<string>()
  const iterator = octokit.paginate.iterator(
    octokit.rest.issues.listLabelsForRepo,
    { owner: ref.owner, repo: ref.repo, per_page: 100 },
  )
  for await (const { data } of iterator) {
    for (const label of data) {
      existingLabels.add(label.name)
    }
  }

  const missingLabels = managedLabels(config)
    .map((label) => label.name)
    .filter((name) => !existingLabels.has(name))
  if (missingLabels.length > 0) {
    findings.push({
      level: 'warn',
      message: `Missing labels: ${missingLabels.join(', ')} — run \`tidebot labels --repo ${ref.owner}/${ref.repo}\``,
    })
  }

  if (config.commands.updateBranchMethod === 'signed-rebase') {
    const workflows = await listWorkflowFiles(octokit, ref)
    if (!workflows.includes(config.signedRebase.workflowFile)) {
      findings.push({
        level: 'error',
        message: `updateBranchMethod is signed-rebase but ${config.signedRebase.workflowFile} is not in .github/workflows`,
      })
    }
  }

  if (config.plugins.plan && config.plan.workflowFile) {
    const workflows = await listWorkflowFiles(octokit, ref)
    if (!workflows.includes(config.plan.workflowFile)) {
      findings.push({
        level: 'warn',
        message: `plan.workflowFile ${config.plan.workflowFile} is not in .github/workflows; /plan will fail`,
      })
    }
  }

  if (findings.every((finding) => finding.level === 'ok')) {
    findings.push({ level: 'ok', message: 'No problems found.' })
  }

  return { findings, config }
}

async function listWorkflowFiles(
  octokit: Octokit,
  { owner, repo }: RepoRef,
): Promise<string[]> {
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: '.github/workflows',
    })
    return Array.isArray(data) ? data.map((entry) => entry.name) : []
  } catch {
    return []
  }
}
