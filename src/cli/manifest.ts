/**
 * The permission and event set Tidebot needs, in one place. `tidebot app
 * create` registers an App from this, and `tidebot doctor` checks a live
 * installation against the same list.
 */
export function appManifest(input: {
  name: string
  webhookUrl: string
  homepageUrl: string
  public: boolean
}): Record<string, unknown> {
  return {
    name: input.name,
    url: input.homepageUrl,
    hook_attributes: { url: input.webhookUrl, active: true },
    redirect_url: undefined,
    public: input.public,
    default_permissions: {
      // Slash-command replies, labels, and generated issues.
      issues: 'write',
      // Required for pulls.merge and for review submission.
      pull_requests: 'write',
      // A squash merge writes to the base branch.
      contents: 'write',
      // Reading the merge gate.
      checks: 'read',
      // Preview deployment rows in the pipeline summary.
      deployments: 'read',
      // CI re-runs, /plan and /deploy dispatch, and plan job logs.
      actions: 'write',
      metadata: 'read',
    },
    // `status` is deliberately absent: it duplicates check_suite and can
    // exhaust the installation rate limit on a busy repository.
    default_events: [
      'issue_comment',
      'pull_request',
      'pull_request_review',
      'push',
      'check_suite',
      'workflow_run',
    ],
  }
}

export function manifestFormPage(
  manifest: Record<string, unknown>,
  actionUrl: string,
  state: string,
): string {
  const json = JSON.stringify(manifest).replace(/</g, '\\u003c')
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Create the Tidebot GitHub App</title></head>
<body>
<p>Redirecting to GitHub to create the App…</p>
<form id="f" action="${actionUrl}?state=${encodeURIComponent(state)}" method="post">
  <input type="hidden" name="manifest" id="manifest">
  <noscript><button type="submit">Continue to GitHub</button></noscript>
</form>
<script>
  document.getElementById('manifest').value = ${JSON.stringify(json)};
  document.getElementById('f').submit();
</script>
</body>
</html>`
}
