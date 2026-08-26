export type PullRequest = {
  id: string
  draft: boolean
  state: string
  title?: string | null
  body?: string | null
  mergeable: boolean | null
  mergeable_state: string | null
  labels: Array<{ name?: string | null }>
  additions: number
  deletions: number
  updated_at?: string | null
  base?: { ref?: string | null } | null
  head: { sha: string; ref?: string | null; repoFullName?: string | null }
  userLogin?: string | null
}

export type CommentContext = {
  body?: string
  commentId?: number
  issueNumber: number
  authorAssociation?: string | null
  userLogin?: string | null
}

export type IntakeKind = 'bug' | 'feature'

export type IntakeCommand = {
  kind: IntakeKind
  description: string
}

export type CheckRun = {
  name: string
  conclusion: string | null
  started_at?: string | null
}

export type Status = {
  context: string
  state: string
  created_at: string
}

export type DeploymentStatus = {
  environment: string
  state: string
  description: string | null
  url: string | null
  updatedAt: string | null
}

export type MergeMethod = 'merge' | 'squash' | 'rebase'

/**
 * `merge` and `rebase` use GitHub's update-branch API. `signed-rebase`
 * dispatches a workflow that performs a real `git rebase` with a GPG
 * signature — see docs/signed-rebase.md.
 */
export type UpdateBranchMethod = 'merge' | 'rebase' | 'signed-rebase'

/** Repository this bot instance is acting on, resolved from the event. */
export type RepoRef = { owner: string; repo: string }

export type TidePolicy = {
  name?: string
  matchLabels: string[]
  requiredLabels?: string[]
  requiredContexts: string[]
  allowSkippedContexts?: string[]
  autoMerge?: boolean
}

export type ResolvedTidePolicy = {
  requiredLabels: string[]
  blockedLabels: string[]
  requiredContexts: string[]
  allowSkippedContexts: string[]
  autoMerge: boolean
  policyName?: string
}

export type TideDecision = {
  ready: boolean
  reasons: string[]
  policyName?: string
}

export type AreaRule = { prefix: string; label: string }

/**
 * One declarative auto-approval rule. Replaces the hard-coded docs-only and
 * content-snapshot rules: a rule matches when every configured facet matches,
 * and an unset facet is not a constraint.
 *
 * `authors` accepts the literal `${bot}` placeholder, which resolves to this
 * App's own `<slug>[bot]` login at evaluation time.
 */
export type AutoApproveRule = {
  name: string
  authors?: string[]
  paths?: string[]
  excludePaths?: string[]
  requiredContexts?: string[]
  blockedLabels?: string[]
  maxChangedLines?: number
}

export type PreviewApp = {
  name: string
  /** GitHub deployment environment reported for this app, when it has one. */
  environment?: string
  /** Check run whose conclusion stands in before a deployment exists. */
  buildCheck?: string
  /** Fallback URL used until a deployment reports its own. */
  url?: string
}

export type BotConfig = {
  plugins: {
    size: boolean
    area: boolean
    commands: boolean
    tide: boolean
    stale: boolean
    dependabot: boolean
    autoApprove: boolean
    plan: boolean
    pipeline: boolean
    intake: boolean
  }
  size: {
    thresholds: { xs: number; s: number; m: number; l: number }
    labelPrefix: string
  }
  area: {
    rules: AreaRule[]
    labelPrefix: string
  }
  commands: {
    trustedAssociations: string[]
    updateBranchMethod: UpdateBranchMethod
    /** Workflow file dispatched by `/deploy`; `/deploy` is off when unset. */
    deployWorkflowFile?: string
    deployInputs?: Record<string, string>
  }
  tide: {
    mergeMethod: MergeMethod
    requiredLabels: string[]
    blockedLabels: string[]
    requiredContexts: string[]
    autoRebaseWhenBehind: boolean
    policies: TidePolicy[]
  }
  signedRebase: {
    /** Workflow file in the target repo that runs the signed rebase. */
    workflowFile: string
    /** Ref the workflow is dispatched on; defaults to the default branch. */
    ref?: string
  }
  plan: {
    /** `workflow_run.name` that produces the plan. */
    workflowName: string
    /** Workflow file dispatched by `/plan`; `/plan` is off when unset. */
    workflowFile?: string
    planJobName: string
    logBeginMarker: string
    logEndMarker: string
    /** Line that starts the human-readable plan body in the job log. */
    actionsMarker: string
    noChangesMarker: string
    /** Regex source matching the plan's one-line change summary. */
    summaryPattern: string
    codeFence: string
    heading: string
  }
  pipeline: {
    /** `workflow_run.name` that publishes previews; refreshes the summary. */
    deployWorkflowName?: string
    previewApps: PreviewApp[]
  }
  stale: {
    daysUntilStale: number
    daysUntilClose: number
    staleLabel: string
    exemptLabels: string[]
  }
  dependabot: {
    enabled: boolean
    autoApprove: boolean
    requiredContexts: string[]
    allowMajorUpdates: boolean
    requireDependenciesLabel: boolean
    allowedPathPrefixes: string[]
  }
  autoApprove: {
    rules: AutoApproveRule[]
  }
  intake: {
    bugLabels: string[]
    featureLabels: string[]
  }
}

/** A partial config as read from YAML, before defaults are merged in. */
export type PartialBotConfig = DeepPartial<BotConfig>

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<infer _U>
    ? T[K]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K]
}

export type CommandName =
  | 'lgtm'
  | 'remove-lgtm'
  | 'approve'
  | 'remove-approve'
  | 'hold'
  | 'unhold'
  | 'retest'
  | 'rebase'
  | 'plan'
  | 'deploy'

export type ParsedCommand = {
  name: CommandName
  cancel: boolean
}
