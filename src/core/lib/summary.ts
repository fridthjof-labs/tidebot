import type {
  BotConfig,
  CheckRun,
  DeploymentStatus,
  PullRequest,
  TideDecision,
} from '../types.js'
import { allCheckRows, alsoFailingLines, checkTally } from './check-view.js'
import { latestCheckRunsByName } from './checks.js'
import {
  PIPELINE_COMMENT_MARKER,
  PLAN_SECTION_BEGIN,
  PLAN_SECTION_END,
  STATUS_BLOCK_BEGIN,
  STATUS_BLOCK_END,
} from './markers.js'
import { previewDeploymentSection } from './previews.js'
import { blockedCheckContexts, blockerLines, verdictFor } from './verdict.js'

function labelChips(pr: PullRequest): string {
  const names = pr.labels
    .map((label) => label.name)
    .filter((name): name is string => Boolean(name))
    .sort((left, right) => left.localeCompare(right))
  return names.length > 0
    ? names.map((name) => `\`${name}\``).join(' ')
    : '_none_'
}

/**
 * One upserted comment per pull request carrying the merge verdict, CI status,
 * preview deployments, and an optional plan section. Sections whose config is
 * empty are omitted rather than rendered blank.
 */
export function formatPipelineSummary(input: {
  checkRuns: CheckRun[]
  deployments: DeploymentStatus[]
  tide: TideDecision
  pr: PullRequest
  config: BotConfig
  deploymentsAvailable?: boolean
  planSection?: string | null
}): string {
  const {
    checkRuns,
    deployments,
    tide,
    pr,
    config,
    deploymentsAvailable = true,
    planSection = null,
  } = input

  const latest = [...latestCheckRunsByName(checkRuns).values()]
  const verdict = verdictFor(tide, checkRuns, config)
  const blockers = tide.ready ? [] : blockerLines(tide, checkRuns)
  const alsoFailing = alsoFailingLines(checkRuns, blockedCheckContexts(tide))

  return [
    PIPELINE_COMMENT_MARKER,
    `> [!${verdict.alert}]`,
    `> **${verdict.icon} ${verdict.headline}**`,
    `> ${verdict.detail}`,
    '',
    `**Commit** \`${pr.head.sha.slice(0, 7)}\` · **Checks** ${checkTally(latest)} · **Labels** ${labelChips(pr)}`,
    ...(blockers.length > 0
      ? ['', '**Blocking the merge**', '', ...blockers]
      : []),
    ...(alsoFailing.length > 0
      ? ['', '**Also unhappy, but not blocking**', '', ...alsoFailing]
      : []),
    ...previewDeploymentSection({
      checkRuns,
      deployments,
      config,
      deploymentsAvailable,
    }),
    ...(planSection
      ? [
          '',
          `#### 🏗️ ${config.plan.heading}`,
          '',
          PLAN_SECTION_BEGIN,
          planSection,
          PLAN_SECTION_END,
        ]
      : []),
    ...(latest.length > 0
      ? [
          '',
          `<details><summary>All checks (${latest.length})</summary>`,
          '',
          ...allCheckRows(checkRuns),
          '',
          '</details>',
        ]
      : []),
  ].join('\n')
}

/**
 * The verdict as it appears inside the pull request body, where a long
 * conversation cannot push it out of view.
 *
 * Must render identically for identical inputs. Writing the body raises
 * `pull_request.edited`, which renders this block again, so a timestamp or any
 * other volatile field would not converge.
 */
export function formatStatusBlock(input: {
  checkRuns: CheckRun[]
  tide: TideDecision
  pr: PullRequest
  config: BotConfig
  commentUrl?: string | null
}): string {
  const { checkRuns, tide, pr, config, commentUrl = null } = input
  const verdict = verdictFor(tide, checkRuns, config)
  const latest = [...latestCheckRunsByName(checkRuns).values()]

  const detail = [
    checkTally(latest),
    `\`${pr.head.sha.slice(0, 7)}\``,
    commentUrl ? `[full status](${commentUrl})` : null,
  ]
    .filter(Boolean)
    .join(' · ')

  // The alert kind the comment uses, so both surfaces read as one status and
  // the verdict carries GitHub's own colour.
  return [
    STATUS_BLOCK_BEGIN,
    `> [!${verdict.alert}]`,
    `> **Tidebot — ${verdict.icon} ${verdict.headline}**`,
    `> ${detail}`,
    STATUS_BLOCK_END,
  ].join('\n')
}

/**
 * Insert or replace the block, leaving the author's text untouched. Appends
 * when the markers are absent.
 */
export function upsertStatusBlock(
  body: string | null | undefined,
  block: string,
): string {
  const existing = body ?? ''
  const begin = existing.indexOf(STATUS_BLOCK_BEGIN)
  const end = existing.indexOf(STATUS_BLOCK_END, begin)

  if (begin !== -1 && end !== -1) {
    return (
      existing.slice(0, begin) +
      block +
      existing.slice(end + STATUS_BLOCK_END.length)
    )
  }

  const prefix = existing.trimEnd()
  return prefix.length > 0 ? `${prefix}\n\n${block}` : block
}

export function extractPlanSection(
  body: string | null | undefined,
): string | null {
  if (!body) {
    return null
  }
  const begin = body.indexOf(PLAN_SECTION_BEGIN)
  if (begin === -1) {
    return null
  }
  const end = body.indexOf(PLAN_SECTION_END, begin)
  if (end === -1) {
    return null
  }
  const trimmed = body.slice(begin + PLAN_SECTION_BEGIN.length, end).trim()
  return trimmed.length > 0 ? trimmed : null
}
