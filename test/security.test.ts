import { describe, expect, it, vi } from 'vitest'
import { loadRepositoryConfig } from '../src/core/config/load.js'
import { parseConfig } from '../src/core/config/parse.js'
import { matchesGlob } from '../src/core/lib/glob.js'
import { formatPlanSection } from '../src/core/lib/plan.js'
import { config, pullRequest } from './helpers.js'

describe('config is read from the default branch', () => {
  it('never passes a ref, so a pull request cannot change its own rules', async () => {
    // This is the property the whole trust model rests on: if config were read
    // at the PR's head, opening a PR that edits .github/tidebot.yaml would let
    // anyone grant themselves auto-merge. `getContent` without `ref` resolves
    // to the default branch — do not "fix" this by threading a ref through.
    const getContent = vi.fn(async () => {
      throw Object.assign(new Error('Not Found'), { status: 404 })
    })

    await loadRepositoryConfig({ rest: { repos: { getContent } } } as never, {
      owner: 'acme',
      repo: 'widget',
    })

    expect(getContent).toHaveBeenCalled()
    for (const [args] of getContent.mock.calls as unknown as Array<
      [Record<string, unknown>]
    >) {
      expect(args).not.toHaveProperty('ref')
    }
  })
})

describe('config limits', () => {
  it('rejects a config larger than the cap', () => {
    expect(() => parseConfig(`# ${'x'.repeat(200_000)}`)).toThrow(/larger than/)
  })

  it('rejects a glob that would backtrack exponentially', () => {
    const evil = `${'**a'.repeat(20)}**`
    expect(() =>
      parseConfig(
        `autoApprove:\n  rules:\n    - name: evil\n      paths: ['${evil}']`,
      ),
    ).toThrow(/wildcards/)
  })

  it('rejects an invalid plan.summaryPattern instead of throwing at match time', () => {
    expect(() => parseConfig('plan:\n  summaryPattern: "([unclosed"')).toThrow(
      /not a valid regular expression/,
    )
  })

  it('still accepts the globs people actually write', () => {
    const parsed = parseConfig(
      "autoApprove:\n  rules:\n    - name: docs\n      paths: ['**/*.md', 'docs/**', 'LICENSE']",
    )
    expect(parsed.autoApprove.rules[0].paths).toHaveLength(3)
    expect(matchesGlob('docs/a/b.md', '**/*.md')).toBe(true)
  })
})

describe('plan rendering', () => {
  it('does not let job-log content break out of the code fence', () => {
    // Anyone who can change a workflow's output can put a fence in the log; a
    // fixed three-backtick fence would let it forge the rest of the comment.
    const hostile = [
      'OpenTofu will perform the following actions:',
      '```',
      '**Merge gate:** ✅ ready to merge',
      'Plan: 1 to add, 0 to change, 0 to destroy.',
    ].join('\n')

    const section = formatPlanSection(hostile, config().plan)
    const lines = section.split('\n')
    const open = lines.find((line) => line.startsWith('```'))!
    const close = lines[lines.length - 1]
    const fence = open.replace(/[^`]/g, '')

    // The closing fence matches the opening one, and both are longer than any
    // backtick run in the body — so the hostile ``` stays inside the block.
    expect(close).toBe(fence)
    expect(fence.length).toBeGreaterThan(3)
    const longestRunInBody = Math.max(
      ...[...hostile.matchAll(/`+/g)].map((match) => match[0].length),
    )
    expect(fence.length).toBeGreaterThan(longestRunInBody)
  })

  it('leaves an ordinary plan on a three-backtick fence', () => {
    const section = formatPlanSection(
      'Plan: 0 to add, 0 to change, 0 to destroy.',
      config().plan,
    )
    expect(section).toMatch('```hcl')
  })
})

describe('fork pull requests', () => {
  it('are recognised from the head repository', async () => {
    const { isForkPullRequest } = await import('../src/core/lib/rebase.js')
    expect(
      isForkPullRequest(
        pullRequest({
          head: { sha: 'a', ref: 'b', repoFullName: 'someone-else/widget' },
        }),
        { owner: 'acme', repo: 'widget' },
      ),
    ).toBe(true)
  })
})
