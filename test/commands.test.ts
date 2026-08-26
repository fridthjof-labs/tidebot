import { describe, expect, it, vi } from 'vitest'
import {
  commandHelp,
  isBotComment,
  isCommandAvailable,
  parseCommentCommands,
} from '../src/core/lib/commands.js'
import { config } from './helpers.js'

describe('parseCommentCommands', () => {
  it('reads several commands from one body', () => {
    expect(parseCommentCommands('/lgtm\n/approve')).toEqual([
      { name: 'lgtm', cancel: false },
      { name: 'approve', cancel: false },
    ])
  })

  it('understands cancel and remove- forms', () => {
    expect(parseCommentCommands('/lgtm cancel')).toEqual([
      { name: 'lgtm', cancel: true },
    ])
    expect(parseCommentCommands('/remove-approve')).toEqual([
      { name: 'remove-approve', cancel: false },
    ])
    expect(parseCommentCommands('/remove-hold')).toEqual([
      { name: 'unhold', cancel: false },
    ])
  })

  it('does not let one command cancel the next', () => {
    expect(parseCommentCommands('/lgtm\n/hold cancel')).toEqual([
      { name: 'lgtm', cancel: false },
      { name: 'hold', cancel: true },
    ])
  })

  it('ignores a command that is not at the start of a line', () => {
    // `/help` output lists every command, so a body mentioning one is common.
    expect(parseCommentCommands("please don't /approve this yet")).toEqual([])
    expect(parseCommentCommands('see `/lgtm` in the docs')).toEqual([])
  })

  it('ignores commands inside a fenced code block', () => {
    expect(parseCommentCommands('```\n/lgtm\n```')).toEqual([])
    expect(parseCommentCommands('~~~\n/approve\n~~~')).toEqual([])
  })

  it('ignores commands in quoted text', () => {
    expect(parseCommentCommands('> /lgtm\n> /approve')).toEqual([])
  })

  it('still reads a command that follows quoted text', () => {
    expect(parseCommentCommands('> they said /approve\n\n/lgtm')).toEqual([
      { name: 'lgtm', cancel: false },
    ])
  })

  it('does not treat the help text as a batch of commands', () => {
    expect(parseCommentCommands(commandHelp(config()))).toEqual([])
  })
})

describe('isBotComment', () => {
  it('recognises any app login, not one hard-coded name', () => {
    expect(isBotComment('tidebot[bot]')).toBe(true)
    expect(isBotComment('some-other-app[bot]')).toBe(true)
    expect(isBotComment('a-human')).toBe(false)
    expect(isBotComment(null)).toBe(false)
  })
})

describe('/help gating', () => {
  it('is not a free way for anyone to make the bot post', async () => {
    // On a public repository anyone can comment; an open /help costs the
    // installation's shared REST quota and posts spam under the bot's name.
    const { replyWithCommandHelp } = await import(
      '../src/core/plugins/commands.js'
    )
    const createComment = vi.fn()
    const ctx = {
      octokit: { rest: { issues: { createComment } } },
      ref: { owner: 'acme', repo: 'widget' },
      config: config(),
      identity: {
        appId: 1,
        slug: 'tidebot',
        name: 'Tidebot',
        login: 'tidebot[bot]',
      },
      defaultBranch: 'main',
    } as never

    await replyWithCommandHelp(ctx, {
      body: '/help',
      issueNumber: 1,
      authorAssociation: 'NONE',
      userLogin: 'drive-by',
    })
    expect(createComment).not.toHaveBeenCalled()

    await replyWithCommandHelp(ctx, {
      body: '/help',
      issueNumber: 1,
      authorAssociation: 'MEMBER',
      userLogin: 'maintainer',
    })
    expect(createComment).toHaveBeenCalledOnce()
  })
})

describe('command availability', () => {
  it('hides /plan and /deploy until a workflow is configured', () => {
    const base = config()
    expect(isCommandAvailable('plan', base)).toBe(false)
    expect(isCommandAvailable('deploy', base)).toBe(false)

    const configured = config({
      plugins: { plan: true },
      plan: { workflowFile: 'infra.yml' },
      commands: { deployWorkflowFile: 'deploy.yml' },
    })
    expect(isCommandAvailable('plan', configured)).toBe(true)
    expect(isCommandAvailable('deploy', configured)).toBe(true)
  })

  it('describes only the commands this repository can run', () => {
    const help = commandHelp(config())
    expect(help).not.toMatch('/plan')
    expect(help).not.toMatch('/deploy')
    expect(help).toMatch('`lgtm` + `approved`')
  })

  it('describes the configured branch-update behaviour', () => {
    expect(
      commandHelp(
        config({ commands: { updateBranchMethod: 'signed-rebase' } }),
      ),
    ).toMatch('re-sign the commits')
  })
})
