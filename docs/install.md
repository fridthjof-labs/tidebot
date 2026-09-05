# Installing Tidebot

Install [mise](https://mise.jdx.dev/getting-started.html) and Git first. The
GitHub release is the supported distribution; an npm package is not published.
The release pins Node and pnpm in `mise.toml`.

<!-- x-release-please-start-version -->
```bash
git clone --branch v0.4.2 --depth 1 https://github.com/fridthjof-labs/tidebot
cd tidebot
mise install
mise exec -- pnpm install --frozen-lockfile
mise exec -- pnpm tidebot help
```
<!-- x-release-please-end -->

Three paths, in increasing order of setup. They are not exclusive — a hosted
instance can serve most repositories while an outlier runs itself in Actions —
but a single repository must use exactly one, or every action happens twice.

## 1. GitHub Actions (no hosted receiver)

```bash
mise exec -- pnpm tidebot init --dir path/to/repo --actions --stale
```

The generated workflow checks this repository out to get the bot's code, so
**`fridthjof-labs/tidebot` must be readable by the runner**: either public, or
reachable with a PAT you add to `actions/checkout` in the generated workflow.
The hosted runtimes have no such requirement.

Commit `.github/tidebot.yaml` and `.github/workflows/tidebot.yml`, then create
the labels it refers to. No App is needed for this — the CLI falls back to
`GITHUB_TOKEN` so a repository can be set up before one exists:

```bash
GITHUB_TOKEN="$(gh auth token)" mise exec -- pnpm tidebot labels --repo my-org/my-repo
GITHUB_TOKEN="$(gh auth token)" mise exec -- pnpm tidebot doctor --repo my-org/my-repo
```

The generated workflow declares the permissions the bot needs. Many
repositories default the workflow token to read-only, and a reusable workflow
cannot be granted more than its caller has — so that block is load-bearing, not
documentation.

The bot always acts as `github-actions[bot]`. A branch update made with the
job's own token does not re-trigger CI, by GitHub's recursion guard. If
auto-rebase must restart CI, add `TIDEBOT_APP_ID` and `TIDEBOT_PRIVATE_KEY` as
repository secrets. Tidebot uses that App token only for the branch update;
labels, comments, approvals, and merges still use `github-actions[bot]`.

Do not also run that App's webhook receiver for the same repository. That
would create a second Tidebot runtime and process every event twice.

## 2. Register the App

```bash
mise exec -- pnpm tidebot app create \
  --org my-org \
  --name tidebot \
  --webhook-url https://hooks.example.com/webhooks/github
```

This opens a browser, hands GitHub a manifest describing exactly the
permissions and events Tidebot needs, and writes the resulting App ID, private
key, and webhook secret to `tidebot-app.json` (mode 600, gitignored).

Add `--public` to make the App installable in organisations other than the one
that owns it. One public App installed across several organisations is the
simplest multi-org setup: one deployment, one identity, one set of secrets.

Then install it on the repositories that should be automated, and set:

```
TIDEBOT_APP_ID
TIDEBOT_PRIVATE_KEY
TIDEBOT_WEBHOOK_SECRET
```

Optionally `TIDEBOT_ALLOWED_OWNERS=org-a,org-b` as a second gate in front of
the installation itself.

### Permissions the manifest requests

| Permission | Why |
| --- | --- |
| Issues: write | command replies, labels, generated issues |
| Pull requests: write | `pulls.merge`, review submission |
| Contents: write | a squash merge writes to the base branch |
| Checks: read | reading the merge gate |
| Commit statuses: read | legacy statuses, where a repository still uses them |
| Deployments: read | preview rows in the pipeline comment |
| Actions: write | CI re-runs, `/plan` and `/deploy`, plan job logs |
| Metadata: read | required by GitHub |

Events: `issue_comment`, `pull_request`, `pull_request_review`, `push`,
`check_suite`, `workflow_run`.

Not `status`. It duplicates `check_suite` and, on a busy repository, is enough
on its own to exhaust the installation's hourly REST quota.

## 3. Deploy the webhook receiver

### Cloudflare Worker

Use a Cloudflare account with Workers and Queues enabled, and a domain in a
Cloudflare zone on that account. The repository's `wrangler.jsonc` and release
workflow operate the maintainer's deployment. For your instance, create
`wrangler.local.jsonc` in the clone's root with this complete configuration:

<!-- consumer-worker:begin -->
```json
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "tidebot",
  "main": "./src/runtime/worker.ts",
  "compatibility_date": "2026-08-01",
  "compatibility_flags": [
    "nodejs_compat"
  ],
  "observability": {
    "enabled": true
  },
  "account_id": "REPLACE_WITH_YOUR_CLOUDFLARE_ACCOUNT_ID",
  "workers_dev": true,
  "routes": [
    {
      "pattern": "hooks.example.com",
      "custom_domain": true
    }
  ],
  "exports": {
    "WebhookDelivery": {
      "type": "durable-object",
      "storage": "sqlite"
    }
  },
  "durable_objects": {
    "bindings": [
      {
        "name": "TIDEBOT_WEBHOOK_DELIVERIES",
        "class_name": "WebhookDelivery"
      }
    ]
  },
  "queues": {
    "producers": [
      {
        "binding": "TIDEBOT_WEBHOOK_QUEUE",
        "queue": "tidebot-webhooks"
      }
    ],
    "consumers": [
      {
        "queue": "tidebot-webhooks",
        "max_batch_size": 10,
        "max_batch_timeout": 1,
        "max_retries": 10,
        "retry_delay": 60,
        "dead_letter_queue": "tidebot-webhooks-dlq"
      }
    ]
  }
}
```
<!-- consumer-worker:end -->

Replace `REPLACE_WITH_YOUR_CLOUDFLARE_ACCOUNT_ID` with your account ID and
`hooks.example.com` with your webhook hostname. If `tidebot` or the queue names
are already used on that account, choose unique names and use them in the
commands below too. Save this configuration in your own deployment repository
so you can reuse it when upgrading; it contains no secrets.

Authenticate and confirm the account before creating resources:

```bash
mise exec -- pnpm exec wrangler login
mise exec -- pnpm exec wrangler whoami
mise exec -- pnpm exec wrangler queues create tidebot-webhooks --config wrangler.local.jsonc
mise exec -- pnpm exec wrangler queues create tidebot-webhooks-dlq --config wrangler.local.jsonc
mise exec -- pnpm exec wrangler deploy --config wrangler.local.jsonc --dry-run
mise exec -- pnpm exec wrangler deploy --config wrangler.local.jsonc
```

Set the credentials from the App registration using the interactive prompts:

```bash
mise exec -- pnpm exec wrangler secret put TIDEBOT_APP_ID --config wrangler.local.jsonc
mise exec -- pnpm exec wrangler secret put TIDEBOT_PRIVATE_KEY --config wrangler.local.jsonc
mise exec -- pnpm exec wrangler secret put TIDEBOT_WEBHOOK_SECRET --config wrangler.local.jsonc
```

Set the App's webhook URL to `https://hooks.example.com/webhooks/github`, using
your hostname, and verify delivery in the App's **Advanced → Recent Deliveries**
page. A successful webhook response confirms receipt; check the Worker logs and
queue for processing failures, then run the per-repository `doctor` below.

The Worker answers `GET /healthz` on its `workers.dev` route and nothing else
there. Webhooks require the custom hostname; `workers.dev` is not a substitute.
Keep the queue consumer and its dead-letter queue under alerting: a message only
lands there after ten failed handler attempts.

For upgrades, check out the desired release tag, install its locked dependencies,
restore your configuration, and repeat the dry-run and deploy with
`--config wrangler.local.jsonc`. Upstream releases do not deploy your instance.
If you automate this in your own CI, use the same release pin and explicit config.

### Node

```bash
export TIDEBOT_APP_ID=... TIDEBOT_PRIVATE_KEY="$(cat key.pem)" TIDEBOT_WEBHOOK_SECRET=...
mise exec -- pnpm tidebot serve            # listens on $PORT, default 3000
```

Expose `POST /webhooks/github` however you already expose things.

## Per-repository setup

Once the App is installed:

```bash
mise exec -- pnpm tidebot init --dir path/to/repo   # writes .github/tidebot.yaml
mise exec -- pnpm tidebot labels --repo my-org/my-repo
mise exec -- pnpm tidebot doctor --repo my-org/my-repo
```

`init` reads the repository: it proposes `area/` rules from the directory
layout and lists the check names it found in existing workflows as comments in
the config — which of them gate a merge is a decision, so it does not guess.

`labels` creates the labels the resolved config refers to. It only recolours or
re-describes labels that already exist; it never deletes one.

`doctor` checks the live installation against what the config needs.

### Release workflows

In the Actions runtime, Tidebot merges as `github-actions[bot]`. GitHub does not let a `GITHUB_TOKEN`
push trigger another workflow's `push` event, so a workflow that only listens on
`push: branches: [main]` will not run after Tidebot merges — a release PR merged
this way leaves the tag uncut until someone pushes to `main` by hand.

Add a second trigger to any workflow that has to run after a Tidebot merge:

```yaml
on:
  push:
    branches: [main]
  workflow_run:
    workflows: [Tidebot]
    types: [completed]
    branches: [main]
```

`branches: [main]` keeps this to the comment-driven runs that can merge;
`pull_request`-triggered Tidebot runs carry the PR branch and are filtered out.
The `app_id`/`private_key` secrets do not help here — they are used only for
branch updates, so the merge itself still comes from `github-actions[bot]`.

## Organisation defaults

Put shared settings in `.github/tidebot.yaml` in the organisation's `.github`
repository and install the App there too. Every repository in that
organisation inherits them and can override any key.

## Stale sweeps

A pull request going quiet produces no webhook, so the sweep is scheduled
rather than event-driven. Either add `.github/workflows/tidebot-stale.yml`
(`tidebot init --stale`), or run it from wherever you run cron:

```bash
mise exec -- pnpm tidebot stale-sweep --repo my-org/my-repo
```
