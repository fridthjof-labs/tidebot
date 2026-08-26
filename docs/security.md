# Security model

Tidebot merges code. Anything that can make it merge, approve, or push is a
privilege escalation, so this is what it trusts and why.

## What Tidebot never does

- **It never checks out or executes repository code.** No `npm install`, no
  build, no test run. The single exception is the signed-rebase workflow, which
  runs `git rebase` on a checkout — and even that executes nothing from the
  tree.
- **It never reads secrets belonging to the repositories it serves.** Plans and
  deploys run in those repositories' own workflows; Tidebot reads the resulting
  logs and check conclusions.
- **It never merges on a check the repository did not declare.** With no
  config, `requiredContexts` is empty and the merge gate is labels only.
  Everything that needs repository-specific knowledge is off by default.

## Trust boundaries

### Configuration comes from the default branch

`.github/tidebot.yaml` is read with no `ref`, which resolves to the default
branch. **A pull request cannot change the rules that govern it.** Opening a PR
that grants itself auto-merge does nothing until that PR is merged, which needs
the existing rules to pass first.

This is load-bearing, and `test/security.test.ts` asserts that no `ref` is ever
passed. Do not "fix" it by threading the PR's head through.

The org layer (`.github` repository) has the same property, and is lower
precedence than the repository's own file.

### Commands are gated on `author_association`

Only `MEMBER`, `OWNER`, and `COLLABORATOR` — GitHub's own assessment, not a
list Tidebot keeps — may run commands, including `/help`. An open `/help` on a
public repository is a free way to make the bot post on demand and spend the
installation's shared REST quota.

Commands must be **the first thing on a line**, and lines inside code fences or
blockquotes are ignored. Without that, quoting a comment or pasting `/help`
output would run every command it mentions.

### Comment bookkeeping is scoped to the bot's own comments

`issues: write` lets an App edit and delete *anyone's* comment. Tidebot finds
its own comments by author *and* marker, never by marker alone — otherwise
pasting `<!-- tidebot-pipeline -->` into a comment would let anyone have their
comment overwritten in place, or deleted as a duplicate. The same applies to
dismissing an approval: it only ever dismisses its own.

### Workflow dispatch runs the branch's own workflow

`/plan` and `/deploy` dispatch a workflow **at the pull request's ref**, which
means they run that branch's version of the workflow file with the repository's
secrets. This is inherent to "run this workflow on this branch" and is why the
commands are restricted to trusted associations — treat the ability to run them
as equivalent to write access.

Signed rebase is the exception: its workflow is always dispatched on the
default branch, so the rebase logic itself is never the PR's version.

Both commands refuse pull requests from forks, where the ref either does not
exist in this repository or collides with an unrelated local branch.

### Fork pull requests

The hosted runtimes handle forks normally — Tidebot only reads them. The
Actions runtime cannot: `GITHUB_TOKEN` is read-only for a fork PR, so the
generated workflow skips them. `pull_request_target` would work and is
supported by the code, because Tidebot never checks out PR content — but adding
it is a decision to make deliberately, not a default.

## Untrusted input

| Input | Handling |
| --- | --- |
| Webhook body | HMAC-verified before any handler runs; 2 MiB cap; unsigned requests cost one HMAC and nothing else |
| Comment text | Parsed for commands only, line-anchored; never interpolated into a shell |
| Config YAML | Size-capped; default `yaml` settings resolve no custom tags and cap alias expansion, so no object construction or billion-laughs |
| Glob patterns | Length- and wildcard-capped at parse time — `**` compiles to `.*`, and many of them backtrack exponentially |
| `plan.summaryPattern` | Compiled at parse time to reject an invalid regex, and only ever run against a bounded prefix |
| Plan job logs | Rendered inside a fence sized to exceed the longest backtick run in the body, so log content cannot break out and forge the rest of the comment |
| Branch names | Passed to shell steps through the environment, never interpolated into a command |

## Blast radius

The App holds write access to pull requests and contents on every repository it
is installed on. A compromise of the private key is equivalent to write access
to all of them.

- Store `TIDEBOT_PRIVATE_KEY` as a secret in the runtime, never in a repository.
- `TIDEBOT_ALLOWED_OWNERS` restricts a shared instance to named owners, on top
  of the installation itself.
- Branch protection still applies. Tidebot cannot merge what GitHub refuses,
  and it is not an admin.
- Third-party actions in this repository's workflows are pinned to commit
  SHAs — a tag can be moved to point at different code, and these jobs hold the
  App key. Dependabot updates the pins.
- `minimumReleaseAge` keeps installs off packages published in the last week,
  which is where most npm account compromises are caught.

### The reusable workflows are pinned, in two places

A caller workflow pins twice, and both must move together:

- `uses: …/run.yml@v0.1.0` selects the **workflow file**.
- `with: ref: v0.1.0` selects the **bot code** that workflow checks out.

Pinning only the first still runs whatever is on this repository's default
branch. `tidebot init` writes both. Moving to a newer version is a one-line
change you review, not something that happens to you.

Pin to a commit SHA rather than a tag if you want to defend against a tag being
moved — a tag in this repository can be repointed by anyone who can push tags
here.

## Rate limits as a safety property

Exhausting the installation quota stops the bot everywhere it is installed, so
limits are treated as correctness, not tuning:

- `status` is deliberately not subscribed; it duplicates `check_suite`.
- Changed paths and check runs are fetched at most once per event, and only
  when an enabled plugin needs them.
- A push fans out to at most 50 open pull requests; the rest are handled by
  their own events.
- Resolved config is cached for five minutes.
- Rate-limit failures answer 503 rather than 500, which makes them legible in
  the delivery log. GitHub does not redeliver failed deliveries either way;
  see [runtimes.md](runtimes.md) for what that loses.

## Reporting

See [SECURITY.md](../SECURITY.md).
