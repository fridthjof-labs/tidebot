import type { Octokit } from '@octokit/rest'
import { readTextWithLimit } from '../lib/body.js'
import type { RepoRef } from '../types.js'

// ponytail: plan comments use at most 60 KiB; 8 MiB leaves room for runner
// chatter without letting an unbounded job log exhaust Worker memory.
const MAX_WORKFLOW_JOB_LOG_BYTES = 8 * 1024 * 1024

async function downloadJobLog(
  octokit: Octokit,
  { owner, repo }: RepoRef,
  jobId: number,
): Promise<string | null> {
  const response = await octokit.request(
    'GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs',
    { owner, repo, job_id: jobId, request: { redirect: 'manual' } },
  )

  const location =
    typeof response.headers.location === 'string'
      ? response.headers.location
      : null
  if (!location) {
    return null
  }

  const logResponse = await fetch(location)
  return logResponse.ok
    ? await readTextWithLimit(
        logResponse.body,
        logResponse.headers.get('content-length'),
        MAX_WORKFLOW_JOB_LOG_BYTES,
      )
    : null
}

export async function downloadWorkflowJobLogs(
  octokit: Octokit,
  ref: RepoRef,
  workflowRunId: number,
  jobName: string,
): Promise<string | null> {
  try {
    const { data: jobs } = await octokit.rest.actions.listJobsForWorkflowRun({
      owner: ref.owner,
      repo: ref.repo,
      run_id: workflowRunId,
      per_page: 100,
    })

    const job = jobs.jobs.find((entry) => entry.name === jobName)
    return job ? await downloadJobLog(octokit, ref, job.id) : null
  } catch {
    return null
  }
}

// ponytail: enough for a matrix that applies every root of a small estate;
// past that the comment would be unreadable long before the cap bites.
const MAX_MATCHED_JOBS = 12

/**
 * Logs for every job whose name starts with `jobNamePrefix`, in the run's own
 * order. A matrix job is named `<job> (<value>)`, so an exact-name lookup
 * finds nothing for one; matching a prefix keeps a single job working and
 * lets a fanned-out one report each leg, labelled by the name that
 * distinguishes it.
 */
export async function downloadMatchingWorkflowJobLogs(
  octokit: Octokit,
  ref: RepoRef,
  workflowRunId: number,
  jobNamePrefix: string,
): Promise<Array<{ name: string; logs: string }>> {
  try {
    const { data: jobs } = await octokit.rest.actions.listJobsForWorkflowRun({
      owner: ref.owner,
      repo: ref.repo,
      run_id: workflowRunId,
      per_page: 100,
    })

    const matched = jobs.jobs
      .filter((entry) => entry.name.startsWith(jobNamePrefix))
      .slice(0, MAX_MATCHED_JOBS)

    const collected: Array<{ name: string; logs: string }> = []
    for (const job of matched) {
      const logs = await downloadJobLog(octokit, ref, job.id)
      if (logs) {
        collected.push({ name: job.name, logs })
      }
    }
    return collected
  } catch {
    return []
  }
}

export async function dispatchWorkflow(
  octokit: Octokit,
  { owner, repo }: RepoRef,
  workflowFile: string,
  ref: string,
  inputs?: Record<string, string>,
): Promise<{ dispatched: boolean; message: string }> {
  try {
    await octokit.rest.actions.createWorkflowDispatch({
      owner,
      repo,
      workflow_id: workflowFile,
      ref,
      ...(inputs ? { inputs } : {}),
    })
    return {
      dispatched: true,
      message: `Queued \`${workflowFile}\` on \`${ref}\`.`,
    }
  } catch (error) {
    return {
      dispatched: false,
      message: error instanceof Error ? error.message : 'Dispatch failed.',
    }
  }
}

export async function rerunFailedWorkflowsForRef(
  octokit: Octokit,
  { owner, repo }: RepoRef,
  ref: string,
): Promise<{ rerunCount: number }> {
  try {
    const { data } = await octokit.rest.actions.listWorkflowRunsForRepo({
      owner,
      repo,
      head_sha: ref,
      per_page: 30,
    })

    const rerunIds = new Set<number>()
    for (const run of data.workflow_runs) {
      if (run.status !== 'completed') {
        continue
      }
      if (
        run.conclusion !== 'failure' &&
        run.conclusion !== 'cancelled' &&
        run.conclusion !== 'timed_out'
      ) {
        continue
      }
      if (rerunIds.has(run.id)) {
        continue
      }

      await octokit.rest.actions.reRunWorkflowFailedJobs({
        owner,
        repo,
        run_id: run.id,
      })
      rerunIds.add(run.id)
    }

    return { rerunCount: rerunIds.size }
  } catch {
    return { rerunCount: 0 }
  }
}
