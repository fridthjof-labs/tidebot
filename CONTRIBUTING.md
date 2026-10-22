# Contributing

Install the tools pinned in `mise.toml`, then run:

```bash
mise install
mise exec -- pnpm install --frozen-lockfile
mise exec -- pnpm check
mise exec -- pnpm serve      # local webhook receiver on :3000
```

`pnpm check` runs Biome, type checking, and tests with coverage thresholds.

## Code layout

- `src/core/lib/` holds decision logic without GitHub API calls.
- `src/core/github/` wraps Octokit requests.
- `src/core/plugins/` combines decisions with GitHub operations.
- `src/core/config/` loads and merges configuration.
- `src/core/bot.ts` coordinates pull-request handling.
- `src/core/webhooks.ts` routes GitHub events.
- `src/runtime/` contains the Actions, Worker, and Node entry points.
- `src/cli/` contains setup and diagnostic commands.

Keep decisions in `lib/` so they can be tested without a client. Match the
surrounding code; Biome handles formatting and linting.

## Changes and tests

For a plugin, add its decision logic, handler, and configuration, then wire it
into `bot.ts` and document it in [configuration](docs/config.md). Leave features
that need repository-specific configuration disabled by default. Fetch changed
paths and checks only when an enabled feature needs them.

Tests in `test/` cover decisions, event routing, and GitHub interactions.
`test/fake-github.ts` connects a real Octokit client to an in-memory repository.
Add a test for the behavior you change, including its failure case.

Preserve these security properties:

- Read configuration from the default branch, not the pull request being checked.
- Edit and delete only comments belonging to the bot, matched by author and marker.
- Parse commands at the start of a line, outside code fences and blockquotes.
- Require passing checks when the repository declares them in its configuration.

See the [security model](docs/security.md) for the reasoning and
[runtimes](docs/runtimes.md) for event processing and delivery behavior.

## Releases

[Release Please](https://github.com/googleapis/release-please) prepares the version,
changelog, tag, and GitHub Release from Conventional Commit subjects. Before 1.0,
a breaking change bumps the minor version. Ordinary `docs:` commits do not
open a release PR or appear in release notes. Use `fix:`, `feat:`, or `perf:`
for changes that should ship; an explicit breaking change remains releasable.

The templates in `templates/workflows/` pin both the reusable workflow's `uses:`
reference and its `with: ref:` checkout reference. Update both when releasing;
see [workflow pinning](docs/security.md#the-reusable-workflows-are-pinned-in-two-places).
