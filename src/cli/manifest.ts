/**
 * The permission and event set Tidebot needs, in one place. `tidebot app
 * create` registers an App from this, and `tidebot doctor` checks a live
 * installation against the same list.
 */
export const APP_PERMISSIONS = {
  // Slash-command replies, labels, and generated issues.
  issues: 'write',
  // Required for pulls.merge and for review submission.
  pull_requests: 'write',
  // A squash merge writes to the base branch.
  contents: 'write',
  // Reading the merge gate.
  checks: 'read',
  // Legacy commit statuses; not implied by `checks`.
  statuses: 'read',
  // Preview deployment rows in the pipeline summary.
  deployments: 'read',
  // CI re-runs, /plan and /deploy dispatch, and plan job logs.
  actions: 'write',
  metadata: 'read',
} as const

// `status` is deliberately absent: it duplicates check_suite and can exhaust
// the installation rate limit on a busy repository.
export const APP_EVENTS = [
  'issue_comment',
  'pull_request',
  'pull_request_review',
  'push',
  'check_suite',
  'workflow_run',
] as const

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
    default_permissions: APP_PERMISSIONS,
    default_events: [...APP_EVENTS],
  }
}

/**
 * A manifest supplied as a file, for registering an App other than Tidebot
 * through the same flow — such as the Secrets-only App an infrastructure root
 * authenticates as. GitHub offers no API to create an App; the manifest flow
 * is the one path that keeps its permissions declared in a reviewed file and
 * hands the credentials to code rather than to a person's clipboard.
 *
 * `redirect_url` is the CLI's to set, since it points at the local callback.
 * An App with no webhook omits `hook_attributes` entirely: GitHub requires
 * `hook_attributes.url` whenever the block is present, even inactive, and
 * rejects the manifest with a bare "url wasn't supplied" otherwise.
 */
export function loadManifest(json: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (error) {
    throw new Error(
      `manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('manifest must be a JSON object')
  }
  const manifest = parsed as Record<string, unknown>

  if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
    throw new Error('manifest.name is required')
  }
  const permissions = manifest.default_permissions
  if (
    typeof permissions !== 'object' ||
    permissions === null ||
    Object.keys(permissions).length === 0
  ) {
    throw new Error(
      'manifest.default_permissions must name at least one permission',
    )
  }
  if ('redirect_url' in manifest) {
    throw new Error(
      'manifest.redirect_url is set by the CLI; remove it from the file',
    )
  }

  const hook = manifest.hook_attributes
  if (
    hook !== undefined &&
    (typeof hook !== 'object' ||
      hook === null ||
      typeof (hook as { url?: unknown }).url !== 'string')
  ) {
    throw new Error(
      'manifest.hook_attributes.url is required when hook_attributes is present; omit the block for an App with no webhook',
    )
  }

  return {
    ...manifest,
    default_events: manifest.default_events ?? [],
    public: manifest.public ?? false,
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
