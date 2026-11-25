<p align="center">
  <img src="assets/tidebot-icon.png" alt="Tidebot icon" width="180">
</p>

# Tidebot

[![Quality](https://github.com/fridthjof-labs/tidebot/actions/workflows/ci.yml/badge.svg)](https://github.com/fridthjof-labs/tidebot/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/fridthjof-labs/tidebot)](https://github.com/fridthjof-labs/tidebot/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Small GitHub pull-request automation inspired by Prow, without Kubernetes.
Tidebot applies labels, handles review commands, and squash-merges ready pull
requests. It reads your existing checks; it never checks out or runs pull
request code.

It can run in GitHub Actions for one repository, or as a GitHub App on a
Cloudflare Worker or Node process for several repositories.

## Install

Install [mise](https://mise.jdx.dev/getting-started.html) and Git first. The
GitHub release is the supported distribution; an npm package is not published.
The release pins Node and pnpm in `mise.toml`.

<!-- x-release-please-start-version -->
```bash
git clone --branch v0.6.1 --depth 1 https://github.com/fridthjof-labs/tidebot
cd tidebot
mise install
mise exec -- pnpm install --frozen-lockfile
mise exec -- pnpm tidebot init --dir ../my-repo --actions
```
<!-- x-release-please-end -->

This writes `.github/tidebot.yaml` and `.github/workflows/tidebot.yml` in the
target repository. Review the config and set `tide.requiredContexts` to the
checks Tidebot should require for a merge. An empty list adds no check
requirements to Tidebot's merge gate.

Commit and push the generated files to the target repository's default branch
so `labels` and `doctor` can read the config. With an authenticated
[GitHub CLI](https://cli.github.com/), create the labels and verify the install:

```bash
GITHUB_TOKEN="$(gh auth token)" mise exec -- pnpm tidebot labels --repo my-org/my-repo
GITHUB_TOKEN="$(gh auth token)" mise exec -- pnpm tidebot doctor --repo my-org/my-repo
```

GitHub Actions is enough for one repository and needs no App or hosting. For several repositories, a named bot identity, or
automatic CI after a branch update, use the [App or hosted setup](docs/install.md).

## Use

Choose the checks and labels that gate a merge:

```yaml
# .github/tidebot.yaml
tide:
  mergeMethod: squash
  requiredContexts: [check]

autoApprove:
  rules:
    - name: docs
      paths: ['**/*.md', LICENSE]
      requiredContexts: [check]
```

`requiredContexts` uses the exact Check Runs API name, such as `check`.
`pnpm tidebot init` suggests names for simple workflow jobs. For matrix jobs,
reusable workflows, and external checks, use the names shown on a real PR.

On a pull request, collaborators can use `/lgtm`, `/approve`, `/hold`,
`/rebase`, and `/retest`. Optional `/plan`, `/deploy`, `/bug`, and `/feature`
commands appear only when configured. A merge needs the required labels, green
checks, and GitHub to report it mergeable.

Tidebot also provides size and area labels, declarative auto-approval,
Dependabot handling, stale pull-request sweeps, and one pipeline-status
comment per pull request.

## A real pull request

In [Tidebot PR #52](https://github.com/fridthjof-labs/tidebot/pull/52), a
maintainer posted [`/lgtm`](https://github.com/fridthjof-labs/tidebot/pull/52#issuecomment-5546033412)
and [`/approve`](https://github.com/fridthjof-labs/tidebot/pull/52#issuecomment-5546033888).
The [bot's final pipeline comment](https://github.com/fridthjof-labs/tidebot/pull/52#issuecomment-5546033452)
shows the merged state, five green checks, and the approval labels. That same
comment is updated as the pull request progresses, keeping the merge decision
and its inputs in one place.

## Security

Tidebot reads configuration from the default branch, gates commands on
GitHub's collaborator association, and never executes pull-request code.
Read the [security model](docs/security.md) and report vulnerabilities through
[SECURITY.md](SECURITY.md).

## Development

```bash
pnpm check
```

See [installation](docs/install.md), [configuration](docs/config.md),
[runtimes](docs/runtimes.md), [signed rebase](docs/signed-rebase.md), and
[contributing](CONTRIBUTING.md). Licensed under the [MIT License](LICENSE).
