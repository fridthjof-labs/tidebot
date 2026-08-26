import type { Octokit } from '@octokit/rest'
import type { BotIdentity } from './identity.js'
import { expandBotPlaceholder } from './identity.js'
import type { AutoApproveRule, BotConfig, RepoRef } from './types.js'

/**
 * Everything a plugin needs about "which repository, under which rules, as
 * whom". Resolved once per event so a single process can serve any number of
 * repositories across any number of organisations.
 */
export type BotContext = {
  octokit: Octokit
  ref: RepoRef
  config: BotConfig
  identity: BotIdentity
  defaultBranch: string
}

export function repoFullName(ref: RepoRef): string {
  return `${ref.owner}/${ref.repo}`
}

export function issueUrl(ref: RepoRef, issueNumber: number): string {
  return `https://github.com/${repoFullName(ref)}/issues/${issueNumber}`
}

/** Resolve an auto-approve rule's authors, expanding `${bot}` to this App. */
export function ruleAuthors(
  ctx: BotContext,
): (rule: AutoApproveRule) => string[] {
  return (rule) => expandBotPlaceholder(rule.authors, ctx.identity)
}

export function isSelf(
  ctx: BotContext,
  login: string | null | undefined,
): boolean {
  return login === ctx.identity.login
}

export type { BotConfig, RepoRef }
