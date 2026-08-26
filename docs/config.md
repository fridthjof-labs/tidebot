# Configuration reference

Tidebot reads `.github/tidebot.yaml` (or `.yml`) from the repository it is
acting on. Every key is optional.

## Layering

Three layers, lowest precedence first:

1. Built-in defaults.
2. `.github/tidebot.yaml` in the owner's `.github` repository.
3. `.github/tidebot.yaml` in the repository itself.

Objects merge key by key. **Arrays replace.** A repository that writes
`requiredContexts: [a]` gets exactly `[a]`, not the union with the org's list —
narrowing a merge gate has to be possible without editing the org.

An unknown top-level key is an error, not a silent no-op. A layer that fails to
parse is reported and skipped: a typo in one repository does not stop the bot
everywhere else.

Resolved config is cached for five minutes, and invalidated immediately when a
push to the default branch touches a config path.

Inspect what a repository actually resolved to:

```bash
pnpm tidebot config --repo my-org/my-repo
```

## Defaults

A repository with no config file gets:

```yaml
plugins:
  size: true
  area: true
  commands: true
  tide: true
  intake: true
  stale: false
  dependabot: false
  autoApprove: false
  plan: false
  pipeline: false

tide:
  mergeMethod: squash
  requiredLabels: [lgtm, approved]
  blockedLabels: [hold]
  requiredContexts: []
  autoRebaseWhenBehind: true
```

Anything needing repository-specific knowledge stays off. A fresh install can
never merge on a check set the repository never declared.

## `plugins`

Master switches. A plugin that is on but unconfigured (`area` with no rules,
`autoApprove` with no rules) does nothing and costs no API calls.

## `size`

```yaml
size:
  thresholds: { xs: 10, s: 50, m: 200, l: 500 }
  labelPrefix: size/
```

Bucketed on `additions + deletions`. Anything above `l` is `xl`.

## `area`

```yaml
area:
  labelPrefix: area/
  rules:
    - prefix: apps/site/
      label: area/site
    - prefix: .github/
      label: area/ci
```

`prefix` is a literal path prefix. Labels under `labelPrefix` that no longer
apply are removed; labels outside it are never touched.

## `commands`

```yaml
commands:
  trustedAssociations: [MEMBER, OWNER, COLLABORATOR]
  updateBranchMethod: merge          # merge | rebase | signed-rebase
  deployWorkflowFile: deploy.yml     # enables /deploy
  deployInputs:
    environment: preview
```

`trustedAssociations` is GitHub's `author_association` on the comment. Anyone
else gets told they need to be a collaborator.

`/deploy` and `/plan` do not exist until their workflow file is configured, and
`/help` lists only what this repository can actually run.

## `tide`

```yaml
tide:
  mergeMethod: squash                # merge | squash | rebase
  requiredLabels: [lgtm, approved]
  blockedLabels: [hold]
  requiredContexts: [Quality / check]
  autoRebaseWhenBehind: true
  policies:
    - name: infra
      matchLabels: [area/infra]
      requiredContexts:
        - OpenTofu / validate
        - OpenTofu / plan
      allowSkippedContexts:
        - OpenTofu / plan
```

`requiredContexts` names check runs exactly as they appear in the Checks tab
(usually `Workflow name / job name`). Legacy commit statuses are consulted too.

The first policy whose `matchLabels` all match replaces the base check set for
that pull request. `allowSkippedContexts` lets a `skipped` conclusion count as
passing — needed when a workflow's own path filters legitimately skip a job.
`autoMerge: false` on a policy makes Tidebot report the gate without merging.

`autoRebaseWhenBehind` only touches pull requests that already carry every
required label and no blocking one.

## `autoApprove`

```yaml
plugins:
  autoApprove: true

autoApprove:
  rules:
    - name: docs
      paths: ['**/*.md', LICENSE, .gitignore]
      excludePaths: ['infra/**']
      requiredContexts: [Quality / check]
      blockedLabels: [area/infra]
    - name: generated-content
      authors: ['${bot}']
      paths: ['src/content/generated/**']
      requiredContexts: [Quality / check]
      maxChangedLines: 2000
```

Each rule applies `tide.requiredLabels` when it matches. It never merges
directly — Tide's own gate still runs, so a rule cannot bypass a required check
it did not list.

Every configured facet must match; an unset facet is not a constraint. A rule
that constrains neither `authors` nor `paths` is rejected at parse time,
because it would approve every pull request in the repository.

`${bot}` resolves to this App's own `<slug>[bot]` login, and `${slug}` to the
slug alone. Both are resolved at evaluation time, so re-registering the App
under a different name does not require a config change.

Globs support `*` (within a segment), `**` (across segments), and `?`. A
pattern with no wildcard matches the exact path or anything beneath it, so
`infra` and `infra/**` behave the same.

## `dependabot`

```yaml
plugins:
  dependabot: true

dependabot:
  enabled: true
  autoApprove: true
  requiredContexts: [Quality / check, Dependency audit]
  allowMajorUpdates: false
  requireDependenciesLabel: true
  allowedPathPrefixes: [package.json, pnpm-lock.yaml, .github/]
```

Separate from `autoApprove` because it reads the version bump out of the title
and body, and because an unsafe-but-recoverable PR gets a branch update or a CI
re-run rather than nothing.

Hard blockers — a major bump, changed paths outside the list, a blocking label,
a missing `dependencies` label — are left alone.

## `plan`

Reports an infrastructure plan into the pipeline comment. Tidebot never runs
the plan; the workflow does, and brackets its output with markers.

```yaml
plugins:
  plan: true

plan:
  workflowName: Infrastructure       # workflow_run.name
  workflowFile: infra.yml            # enables /plan
  planJobName: OpenTofu / plan
  logBeginMarker: TIDEBOT_PLAN_LOG_BEGIN
  logEndMarker: TIDEBOT_PLAN_LOG_END
  actionsMarker: 'will perform the following actions:'
  noChangesMarker: 'No changes.'
  codeFence: hcl
  heading: Infrastructure plan
```

In the plan job:

```yaml
- run: |
    echo TIDEBOT_PLAN_LOG_BEGIN
    tofu plan -no-color
    echo TIDEBOT_PLAN_LOG_END
```

The defaults suit OpenTofu and Terraform. The markers are configurable for
anything else that produces a plan-shaped diff.

When the same workflow runs on a push to the default branch, Tidebot comments
the apply result on the pull request whose merge commit triggered it.

## `pipeline`

```yaml
plugins:
  pipeline: true

pipeline:
  deployWorkflowName: Deploy         # workflow_run.name that refreshes the comment
  previewApps:
    - name: Site
      environment: Site Preview      # GitHub deployment environment
      buildCheck: Build / site       # stands in before a deployment exists
      url: https://site-preview.example
```

With no `previewApps` the preview table is omitted entirely rather than
rendered empty. A live deployment's own URL always wins over `url`.

## `stale`

```yaml
plugins:
  stale: true

stale:
  daysUntilStale: 14
  daysUntilClose: 7
  staleLabel: stale
  exemptLabels: [hold, pinned, dependencies]
```

Activity is the most recent commit on the branch *or* comment from a human,
whichever is later. Bot comments do not count, and neither does `updated_at` —
both are reset by Tidebot's own pipeline comment and by every CI run, which
would keep an abandoned pull request alive indefinitely.

Commenting on a stale pull request withdraws the label. If the comment lookup
fails, nothing is labelled or closed: a decision to close cannot be made on
evidence Tidebot could not read.

The comment lookup only runs once a pull request is already a candidate by
branch age, so the common path costs no extra API call.

Closing needs a scheduled sweep — see [install.md](install.md#stale-sweeps).

## `intake`

```yaml
intake:
  bugLabels: [bug]
  featureLabels: [enhancement]
```

`/bug` and `/feature` on a plain issue create a structured, labelled issue
linked back to the source comment. The comment id is embedded in the generated
issue, so a redelivered webhook finds the existing issue instead of creating a
second one.

## `signedRebase`

```yaml
signedRebase:
  workflowFile: tidebot-rebase.yml
  ref: main                          # defaults to the default branch
```

Only used when `commands.updateBranchMethod` is `signed-rebase`. See
[signed-rebase.md](signed-rebase.md).
