# Installing Tidebot

The CLI runs from a clone until the package is published:

```bash
git clone https://github.com/fridthjof-labs/tidebot && cd tidebot && pnpm install
pnpm tidebot help
```

Once it is published to npm, every `pnpm tidebot …` below becomes `npx tidebot …`.

Three paths, in increasing order of setup. They are not exclusive — a hosted
instance can serve most repositories while an outlier runs itself in Actions —
but a single repository must use exactly one, or every action happens twice.

## 1. Actions only (no App, no hosting)

```bash
pnpm tidebot init --dir path/to/repo --actions --stale
```

The generated workflow checks this repository out to get the bot's code, so
**`fridthjof-labs/tidebot` must be readable by the runner**: either public, or
reachable with a PAT you add to `actions/checkout` in the generated workflow.
The hosted runtimes have no such requirement.

Commit `.github/tidebot.yaml` and `.github/workflows/tidebot.yml`. Then create
the labels the config refers to — either by hand, or with an App (below), or by
letting the first `/lgtm` fail once and creating them from the error.

The bot acts as `github-actions[bot]`. Everything works except one thing: a
push made with the job's own token does not re-trigger CI, by GitHub's own
recursion guard. Auto-rebase therefore updates the branch but leaves checks
where they were. Supplying App credentials (`TIDEBOT_APP_ID`,
`TIDEBOT_PRIVATE_KEY` as repository secrets) fixes that without changing
anything else.

## 2. Register the App

```bash
pnpm tidebot app create \
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
| Deployments: read | preview rows in the pipeline comment |
| Actions: write | CI re-runs, `/plan` and `/deploy`, plan job logs |
| Metadata: read | required by GitHub |

Events: `issue_comment`, `pull_request`, `pull_request_review`, `push`,
`check_suite`, `workflow_run`.

Not `status`. It duplicates `check_suite` and, on a busy repository, is enough
on its own to exhaust the installation's hourly REST quota.

## 3. Deploy the webhook receiver

### Cloudflare Worker

```bash
pnpm install
npx wrangler secret put TIDEBOT_APP_ID
npx wrangler secret put TIDEBOT_PRIVATE_KEY
npx wrangler secret put TIDEBOT_WEBHOOK_SECRET
pnpm deploy:workers
```

Point the App's webhook URL at `https://<your-host>/webhooks/github`.

The Worker answers `GET /healthz` on its `workers.dev` route and nothing else
there — webhooks are served only through the custom hostname, so the
`workers.dev` URL cannot be used to reach the bot even if it is discovered.
Restricting that hostname to GitHub's published webhook source ranges at the
edge is worth doing and is not something this repository configures for you.

### Node

```bash
export TIDEBOT_APP_ID=... TIDEBOT_PRIVATE_KEY="$(cat key.pem)" TIDEBOT_WEBHOOK_SECRET=...
pnpm tidebot serve            # listens on $PORT, default 3000
```

Expose `POST /webhooks/github` however you already expose things.

## Per-repository setup

Once the App is installed:

```bash
pnpm tidebot init --dir path/to/repo   # writes .github/tidebot.yaml
pnpm tidebot labels --repo my-org/my-repo
pnpm tidebot doctor --repo my-org/my-repo
```

`init` reads the repository: it proposes `area/` rules from the directory
layout and lists the check names it found in existing workflows as comments in
the config — which of them gate a merge is a decision, so it does not guess.

`labels` creates the labels the resolved config refers to. It only recolours or
re-describes labels that already exist; it never deletes one.

`doctor` checks the live installation against what the config needs.

## Organisation defaults

Put shared settings in `.github/tidebot.yaml` in the organisation's `.github`
repository and install the App there too. Every repository in that
organisation inherits them and can override any key.

## Stale sweeps

A pull request going quiet produces no webhook, so the sweep is scheduled
rather than event-driven. Either add `.github/workflows/tidebot-stale.yml`
(`tidebot init --stale`), or run it from wherever you run cron:

```bash
pnpm tidebot stale-sweep --repo my-org/my-repo
```
