import type { Octokit } from '@octokit/rest'
import { readTextWithLimit } from '../lib/body.js'
import type { RepoRef } from '../types.js'

// ponytail: plan comments use at most 60 KiB; 8 MiB leaves room for runner
// chatter without letting an unbounded job log exhaust Worker memory.
const MAX_WORKFLOW_JOB_LOG_BYTES = 8 * 1024 * 1024

export async function downloadWorkflowJobLogs(
  octokit: Octokit,
  { owner, repo }: RepoRef,
  workflowRunId: number,
  jobName: string,
): Promise<string | null> {
  try {
    const { data: jobs } = await octokit.rest.actions.listJobsForWorkflowRun({
      owner,
      repo,
      run_id: workflowRunId,
      per_page: 100,
    })

    const job = jobs.jobs.find((entry) => entry.name === jobName)
    if (!job) {
      return null
    }

    const response = await octokit.request(
      'GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs',
      { owner, repo, job_id: job.id, request: { redirect: 'manual' } },
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
  } catch {
    return null
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
