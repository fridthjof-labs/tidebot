# Runtimes

One core, three entry points. All of them resolve config per repository from
the GitHub API, so nothing about which repository a build serves is baked in.

| | GitHub Actions | Cloudflare Worker | Node |
| --- | --- | --- | --- |
| Entry point | `src/runtime/action.ts` | `src/runtime/worker.ts` | `src/runtime/node.ts` |
| Trigger | workflow event | `POST /webhooks/github` | `POST /webhooks/github` |
| App required | no; optional for branch updates | yes | yes |
| Latency | runner cold start | milliseconds | milliseconds |
| Cost | Actions minutes | free tier | a process |

## GitHub Actions

`tidebot run` reads `$GITHUB_EVENT_PATH` and dispatches the same handlers the
webhook runtimes use. There is no signature to verify: GitHub authenticated the
delivery by starting the job.

It authenticates as `github-actions[bot]` using the job's `GITHUB_TOKEN`.
Because branch updates made with that token do not trigger workflows, optional
App credentials can supply a separate token for that operation alone. All
visible actions still come from `github-actions[bot]`.

The generated workflow serialises per pull request with a `concurrency` group,
so two events cannot both try to merge the same PR.

It does not subscribe to `workflow_run` by default: `check_suite` already means
"CI finished", and listening to every workflow starts a run for each one,
Tidebot's own included. Uncomment that trigger, naming the specific workflows,
if you enable the `plan` or `pipeline` plugins — they read job logs and
deployment statuses that only `workflow_run` reports.

## The core layers

Below the runtimes, the core is three layers:

- `core/github/` is the only place that constructs a GitHub request. Nothing
  above it names an endpoint, a status code or a snake_case field.
- `core/lib/` is pure. It holds the merge gate and every rendered string, so
  both are testable without a client.
- `core/plugins/` is one file per behaviour, composing the two.

`test/fake-github.ts` serves an in-memory repository to a real `Octokit`
instance through a custom `fetch`. Pagination, request building and error
construction are the client's own, so tests exercise the same code paths the
bot does.

## One runtime per repository

The three runtimes are alternatives, not layers. A repository that both installs
the App *and* keeps `.github/workflows/tidebot.yml` runs every handler twice
under two identities — `github-actions[bot]` and `<slug>[bot]` — which doubles
the API cost against a shared rate limit and races two writers against the same
pull request.

Tidebot degrades rather than duplicating: marked comments are matched by author
type, so whichever identity runs second adopts the comment the first one left,
and command replies are keyed to the comment that triggered them. `tidebot
doctor` warns when it sees both. The configuration is still the thing to fix —
delete the workflow, or drop the repository from the App installation.

## Cloudflare Worker

The request path verifies the signature and body limit, writes the delivery to
a Cloudflare Queue, and returns `202`. Queue consumers run the GitHub handlers;
clients and resolved config are cached per isolate.

Queues deliver at least once. One SQLite-backed Durable Object per
`X-GitHub-Delivery` ID prevents concurrent processing and suppresses completed
replays for seven days. Failed handlers retry ten times before Cloudflare moves
the message to `tidebot-webhooks-dlq` (`tidebot-webhooks-preview-dlq` in the
preview environment).

Two routes:

- `GET /healthz` — for deploy verification, and the only thing served on the
  `workers.dev` hostname.
- `POST /webhooks/github` — signature-verified, 2 MiB body cap, then queued.

An intake failure is returned to GitHub and is not automatically redelivered.
Once Cloudflare accepts the queue write, handler failures and GitHub rate limits
retry outside the webhook response deadline. The dead-letter queue is the
operator-visible terminal state; inspect and redrive it before discarding a
failed one-shot command.

Config is read from the GitHub API rather than bundled, so a config change does
not need a redeploy.

## Node

Same handlers behind `node:http`. `tidebot serve`, `$PORT`, default 3000.
Useful behind a tunnel for local development, and for anywhere a Worker is not
an option.

## Sharing one instance across organisations

Install one App — made public at registration — on every organisation. The
installation *is* the allowlist: an event for a repository the App is not
installed on never arrives.

`TIDEBOT_ALLOWED_OWNERS` adds a second gate for an installation added by
mistake. It is a comma-separated list of owner logins; unset means no
restriction.

Per-repository behaviour comes entirely from each repository's own config, so
one deployment can serve organisations with completely different merge policies.

## Rate limits

Every REST call is charged to the installation, and a busy repository can
exhaust the hourly quota. What keeps it down:

- Not subscribing to `status` — it duplicates `check_suite`. The manifest in
  `tidebot app create` omits it, and `tidebot doctor` warns if it is on.
- Changed paths and check runs are fetched at most once per event, and only
  when an enabled plugin actually needs them.
- Config is cached rather than re-read per event.
- A plugin that is on but has no rules makes no calls at all.
