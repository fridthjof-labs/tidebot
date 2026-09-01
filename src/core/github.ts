/**
 * The GitHub API adapter, split by the resource each call touches. Everything
 * above this layer talks in domain terms (`RepoRef`, `PullRequest`) and never
 * constructs an Octokit request itself.
 */
export * from './github/actions.js'
export * from './github/checks.js'
export * from './github/clients.js'
export * from './github/comments.js'
export * from './github/contents.js'
export * from './github/labels.js'
export * from './github/pulls.js'
