<p align="center">
  <img src="assets/tidebot-icon.png" alt="Tidebot icon" width="180">
</p>

# Tidebot

Prow-style repository automation for GitHub, without Kubernetes.

Tidebot is the merge-automation half of [Prow](https://docs.prow.k8s.io) —
`/lgtm` and `/approve` commands, size and area labels, a Tide-style merge gate,
Dependabot handling, stale sweeps — as a single GitHub App that runs on a
Cloudflare Worker, a Node process, or nothing at all but GitHub Actions.

Prow is excellent and needs a Kubernetes cluster, a control plane, and a
Postgres or in-cluster state store to run it. Tidebot targets the case where
that is the wrong shape: a handful of repositories across a few organisations
that want the same review discipline without the same operational surface.

| | Prow | Tidebot |
| --- | --- | --- |
| Runtime | Kubernetes cluster | Worker, Node, or GitHub Actions |
| State | In-cluster | None — GitHub is the state |
| Config | Cluster-wide `config.yaml` | `.github/tidebot.yaml` per repo, layered over the org |
| Jobs | Runs your CI | Reads your CI; never runs it |

Tidebot never executes repository code. It reads check results and acts on
labels, comments, and merges, so an install is not a new place for a build to
run.

## Install

The CLI is not published to npm yet, so run it from a clone:

```bash
git clone https://github.com/fridthjof-labs/tidebot && cd tidebot && pnpm install
```

Then, for the target repository:

```bash
pnpm tidebot init --dir ../my-repo --actions
```

That writes `.github/tidebot.yaml` and a workflow that runs Tidebot inside the
repository — no App, no hosting, no secrets. Commit it and `/lgtm` works.

For a hosted instance across several repositories, or to act as a named bot
rather than `github-actions[bot]`, register the App:

```bash
pnpm tidebot app create --org my-org --webhook-url https://hooks.example.com/webhooks/github
```

Full paths, including the hosted deployment, are in [docs/install.md](docs/install.md).

## Commands

| Command | Effect |
| --- | --- |
| `/lgtm`, `/lgm` | add the `lgtm` label |
| `/lgtm cancel`, `/remove-lgtm` | remove it |
| `/approve` | add `approved` and submit an APPROVE review from the bot |
| `/approve cancel`, `/remove-approve` | remove the label and dismiss the review |
| `/hold` | block auto-merge |
| `/unhold`, `/remove-hold` | allow it again |
| `/retest` | how to re-run CI on this branch |
| `/rebase` | bring the branch onto its base |
| `/plan` | run the configured plan workflow on this branch |
| `/deploy` | run the configured preview deploy workflow |
| `/bug`, `/feature` | turn an issue comment into a structured, labelled issue |
| `/help` | list the commands this repository actually has |

Only `MEMBER`, `OWNER`, and `COLLABORATOR` may run commands by default.
`/plan` and `/deploy` appear only when their workflow is configured.

`/approve` also submits a review because GitHub refuses self-approval: the bot
proxies it, naming who asked, so a solo maintainer still gets a green check.

## Automatic behaviour

- **Size labels** `size/xs` … `size/xl` from the diff.
- **Area labels** from changed paths, per configured rule.
- **Merge gate** — squash-merges when the required labels are present, no
  blocking label is set, required checks pass, and GitHub reports the PR
  mergeable. Per-label policies can require a different check set.
- **Auto-rebase** — when the base branch moves, already-approved PRs are
  brought forward so their checks re-run without a manual click.
- **Auto-approve rules** — declarative: a rule matching authors and/or paths,
  with its own required checks, applies the merge labels. This covers
  docs-only changes, generated-content commits, and anything else you can
  describe by author and path.
- **Dependabot** — safe updates (non-major, expected paths, checks green) get
  the merge labels. Ones that are one branch-update or CI re-run away get that
  automatically. Hard blockers are left for a human.
- **Stale** — inactive PRs are labelled, then closed. Inactivity is measured
  from the last commit on the branch, not `updated_at`, which the bot's own
  activity would otherwise keep resetting.
- **Pipeline comment** — one upserted comment per PR with preview
  deployments, CI status, an optional infrastructure plan, and the merge gate.

## Configuration

Everything above is off or empty by default until a repository asks for it. A
repository with no config gets size labels, area labels, commands, and a merge
gate of `lgtm` + `approved` with no required checks.

```yaml
# .github/tidebot.yaml
tide:
  requiredContexts: [Quality / check]

autoApprove:
  rules:
    - name: docs
      paths: ['**/*.md', LICENSE]
      excludePaths: ['infra/**']
      requiredContexts: [Quality / check]
```

Config is layered: built-in defaults, then `.github/tidebot.yaml` in the
organisation's `.github` repository, then the repository's own. Objects merge;
arrays replace, so a repository narrowing `requiredContexts` gets exactly its
own list. Full reference: [docs/config.md](docs/config.md).

## Runtimes

| | Use when | Setup |
| --- | --- | --- |
| **GitHub Actions** | One repository, or no infrastructure | One workflow file |
| **Cloudflare Worker** | Many repositories, instant response | App + `wrangler deploy` |
| **Node** | Self-hosted, behind your own network | App + a process and a tunnel |

All three run the same core. See [docs/runtimes.md](docs/runtimes.md).

## Signed rebase

`/rebase` defaults to GitHub's update-branch API, which merges the base into
the branch. Set `commands.updateBranchMethod: signed-rebase` and Tidebot
instead dispatches a workflow that performs a real linear rebase and GPG-signs
every commit, so the branch stays linear and GitHub marks it Verified.

This needs a machine user, because GitHub will not verify a signature against
an App's `[bot]` identity. The reasoning and the setup are in
[docs/signed-rebase.md](docs/signed-rebase.md).

## Security

Tidebot never checks out or executes repository code, and it reads its
configuration from the default branch — so a pull request cannot change the
rules that govern it. Commands are gated on GitHub's own `author_association`
and must start a line, so quoting a comment cannot run them.

The full trust model, including what is deliberately *not* defended against,
is in [docs/security.md](docs/security.md). Report vulnerabilities per
[SECURITY.md](SECURITY.md).

## Diagnosing an install

```bash
pnpm tidebot doctor --repo my-org/my-repo
```

Reports missing permissions, missing event subscriptions, missing labels, a
config that failed to parse, and workflows a command refers to but that do not
exist — the failures that otherwise look like the bot silently ignoring you.

## Development

```bash
pnpm install
pnpm check      # lint, typecheck, tests with coverage thresholds
pnpm serve      # local webhook receiver on :3000
```

Architecture, the invariants that must not be broken, and how to add a plugin
are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

MIT.
