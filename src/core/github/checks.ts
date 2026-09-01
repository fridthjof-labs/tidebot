import type { Octokit } from '@octokit/rest'
import { hasHttpStatus } from '../lib/http.js'
import type { CheckRun, DeploymentStatus, RepoRef, Status } from '../types.js'

function isAccessError(error: unknown): boolean {
  return hasHttpStatus(error, 403, 404)
}

/**
 * Check runs plus legacy commit statuses.
 *
 * Statuses need their own `statuses: read` grant, which check runs do not
 * imply. A repository that has none — most do now — must not have every event
 * fail on a permission it does not need, so a refusal degrades to an empty
 * list rather than taking the handler down.
 */
export async function getChecksForRef(
  octokit: Octokit,
  { owner, repo }: RepoRef,
  ref: string,
): Promise<{ checkRuns: CheckRun[]; statuses: Status[] }> {
  const [{ data: checks }, statuses] = await Promise.all([
    octokit.rest.checks.listForRef({ owner, repo, ref, per_page: 100 }),
    octokit.rest.repos
      .listCommitStatusesForRef({ owner, repo, ref, per_page: 100 })
      .then(({ data }) => data)
      .catch((error: unknown) => {
        if (isAccessError(error)) {
          return []
        }
        throw error
      }),
  ])

  return {
    checkRuns: checks.check_runs.map((run) => ({
      name: run.name,
      conclusion: run.conclusion,
      started_at: run.started_at,
      completed_at: run.completed_at,
      url: run.html_url,
    })),
    statuses: statuses.map((status) => ({
      context: status.context,
      state: status.state,
      created_at: status.created_at,
    })),
  }
}

export async function getDeploymentStatusesForRef(
  octokit: Octokit,
  ref: RepoRef,
  sha: string,
): Promise<{ deployments: DeploymentStatus[]; available: boolean }> {
  try {
    return {
      deployments: await listDeploymentStatusesForRef(octokit, ref, sha),
      available: true,
    }
  } catch {
    return { deployments: [], available: false }
  }
}

async function listDeploymentStatusesForRef(
  octokit: Octokit,
  { owner, repo }: RepoRef,
  ref: string,
): Promise<DeploymentStatus[]> {
  const latestByEnvironment = new Map<
    string,
    { id: number; created_at: string }
  >()
  const iterator = octokit.paginate.iterator(
    octokit.rest.repos.listDeployments,
    { owner, repo, ref, per_page: 100 },
  )

  for await (const { data } of iterator) {
    for (const deployment of data) {
      if (!deployment.environment) {
        continue
      }
      const existing = latestByEnvironment.get(deployment.environment)
      if (!existing || deployment.created_at > existing.created_at) {
        latestByEnvironment.set(deployment.environment, {
          id: deployment.id,
          created_at: deployment.created_at,
        })
      }
    }
  }

  const results: DeploymentStatus[] = []
  for (const [environment, { id }] of latestByEnvironment) {
    const { data: statuses } = await octokit.rest.repos.listDeploymentStatuses({
      owner,
      repo,
      deployment_id: id,
      per_page: 1,
    })
    const latest = statuses[0]
    results.push({
      environment,
      state: latest?.state ?? 'unknown',
      description: latest?.description ?? null,
      url:
        latest?.environment_url ||
        latest?.target_url ||
        latest?.log_url ||
        null,
      updatedAt: latest?.updated_at ?? null,
    })
  }

  return results.sort((left, right) =>
    left.environment.localeCompare(right.environment),
  )
}
