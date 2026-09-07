# Installing Tidebot

Install [mise](https://mise.jdx.dev/getting-started.html) and Git first. The
GitHub release is the supported distribution; an npm package is not published.
The release pins Node and pnpm in `mise.toml`.

<!-- x-release-please-start-version -->
```bash
git clone --branch v0.5.0 --depth 1 https://github.com/fridthjof-labs/tidebot
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

Use a Cloudflare account with Workers and Queues enabled. The repository's
`wrangler.jsonc` deploys **any** instance: it pins no `account_id` and declares
no `routes`, so you do not need a config of your own.

State the account, then deploy from a clone of the release tag:

```bash
export CLOUDFLARE_ACCOUNT_ID=<your 32-character account ID>
export CLOUDFLARE_API_TOKEN=<a token scoped to that account>
npx wrangler queues create tidebot-webhooks
npx wrangler queues create tidebot-webhooks-dlq
npx wrangler secret put TIDEBOT_APP_ID
npx wrangler secret put TIDEBOT_PRIVATE_KEY
npx wrangler secret put TIDEBOT_WEBHOOK_SECRET
pnpm deploy:workers
```

`CLOUDFLARE_ACCOUNT_ID` is required, not merely supported. This Worker holds a
GitHub App private key, and a Cloudflare API token can reach more than one
account, so the target is stated on purpose rather than inferred;
`scripts/check-deploy-target.sh` stops a deploy that has not stated it.

Two things to change if you run more than one instance on a single Cloudflare
account — the maintainer's deployment and yours, say. Worker and Queue names
are account-scoped, so give yours its own: pass `--name your-tidebot` to
`wrangler deploy`, and create and bind Queues under your own names. Two
instances sharing a name do not coexist; the second one replaces the first.

Attach your webhook hostname as a **Custom Domain** on the Worker, through
whatever declares your infrastructure. It is deliberately not in
`wrangler.jsonc`: a route there would let each deploy reattach a hostname your
OpenTofu or dashboard config believes it owns, and the two would fight over it.

Set the App's webhook URL to `https://<your hostname>/webhooks/github` and
verify delivery in the App's **Advanced → Recent Deliveries** page. A
successful webhook response confirms receipt; check the Worker logs and queue
for processing failures, then run the per-repository `doctor` below.

The Worker answers `GET /healthz` on its `workers.dev` route and nothing else
there. Webhooks require the custom hostname; `workers.dev` is not a substitute.
Keep the queue consumer and its dead-letter queue under alerting: a message
only lands there after ten failed handler attempts.

Upgrading is checking out the new release tag, installing its locked
dependencies, and deploying again with the same `CLOUDFLARE_ACCOUNT_ID` and
`--name`. Upstream releases deploy the maintainer's instance, never yours.

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
