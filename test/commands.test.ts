import { describe, expect, it, vi } from 'vitest'
import {
  commandHelp,
  isBotComment,
  isCommandAvailable,
  parseCommentCommands,
} from '../src/core/lib/commands.js'
import { commandReplyMarker } from '../src/core/lib/markers.js'
import {
  handleIssueCommentCommand,
  isTrusted,
} from '../src/core/plugins/commands.js'
import { type FakeComment, fakeGitHub } from './fake-github.js'
import { config, context } from './helpers.js'

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

  it('keeps only the last mention of a repeated command', () => {
    // Applying then immediately withdrawing the label is nobody's intent.
    expect(parseCommentCommands('/lgtm /lgtm cancel')).toEqual([
      { name: 'lgtm', cancel: true },
    ])
    expect(parseCommentCommands('/approve\n/approve')).toEqual([
      { name: 'approve', cancel: false },
    ])
  })

  it('reads several commands from one line', () => {
    expect(parseCommentCommands('/lgtm /approve')).toEqual([
      { name: 'lgtm', cancel: false },
      { name: 'approve', cancel: false },
    ])
    expect(parseCommentCommands('/approve /lgtm /hold')).toEqual([
      { name: 'approve', cancel: false },
      { name: 'lgtm', cancel: false },
      { name: 'hold', cancel: false },
    ])
  })

  it('attaches cancel to the command it follows on a shared line', () => {
    expect(parseCommentCommands('/lgtm cancel /approve')).toEqual([
      { name: 'lgtm', cancel: true },
      { name: 'approve', cancel: false },
    ])
  })

  it('stops at the first word that is not a command', () => {
    // The leading-token rule has to survive multi-command lines, or
    // "/hold we should also /approve later" would approve.
    expect(parseCommentCommands('/hold we should also /approve later')).toEqual(
      [{ name: 'hold', cancel: false }],
    )
  })

  it('tolerates punctuation between commands', () => {
    expect(parseCommentCommands('/lgtm, /approve!')).toEqual([
      { name: 'lgtm', cancel: false },
      { name: 'approve', cancel: false },
    ])
  })

  it('does not let cancel revive a remove- form', () => {
    expect(parseCommentCommands('/remove-lgtm cancel')).toEqual([
      { name: 'remove-lgtm', cancel: false },
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

describe('command trust', () => {
  it('verifies write access when a webhook reports a collaborator as a contributor', async () => {
    const getCollaboratorPermissionLevel = vi.fn(async () => ({
      data: { permission: 'admin' },
    }))
    const trusted = await isTrusted(
      context({
        octokit: {
          rest: { repos: { getCollaboratorPermissionLevel } },
        } as never,
      }),
      {
        authorAssociation: 'CONTRIBUTOR',
        issueNumber: 1,
        userLogin: 'maintainer',
      },
    )

    expect(trusted).toBe(true)
    expect(getCollaboratorPermissionLevel).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'widget',
      username: 'maintainer',
    })
  })

  it('keeps read-only contributors untrusted', async () => {
    const trusted = await isTrusted(
      context({
        octokit: {
          rest: {
            repos: {
              getCollaboratorPermissionLevel: vi.fn(async () => ({
                data: { permission: 'read' },
              })),
            },
          },
        } as never,
      }),
      {
        authorAssociation: 'CONTRIBUTOR',
        issueNumber: 1,
        userLogin: 'reader',
      },
    )

    expect(trusted).toBe(false)
  })

  it('does not widen a policy that excludes collaborators', async () => {
    const getCollaboratorPermissionLevel = vi.fn()
    const trusted = await isTrusted(
      context({
        config: config({
          commands: { trustedAssociations: ['MEMBER', 'OWNER'] },
        }),
        octokit: {
          rest: { repos: { getCollaboratorPermissionLevel } },
        } as never,
      }),
      {
        authorAssociation: 'CONTRIBUTOR',
        issueNumber: 1,
        userLogin: 'maintainer',
      },
    )

    expect(trusted).toBe(false)
    expect(getCollaboratorPermissionLevel).not.toHaveBeenCalled()
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

/**
 * Two Tidebot runtimes in one repository — the App and the in-repo Actions
 * workflow — each answered every slash command, so a `/plan` on an
 * unconfigured repository produced two identical refusals. The reply is keyed
 * to the comment that asked for it, so the second runtime edits the first
 * answer instead of adding its own.
 */
describe('command replies', () => {
  function harness(comments: FakeComment[]) {
    const { octokit, spy, db } = fakeGitHub({ comments })
    return {
      octokit,
      db,
      createComment: spy.createComment,
      updateComment: spy.updateComment,
    }
  }

  const trigger = {
    body: '/plan',
    commentId: 555,
    issueNumber: 42,
    authorAssociation: 'MEMBER',
    userLogin: 'froppa',
  }

  it('marks its reply with the triggering comment', async () => {
    const { octokit, createComment } = harness([])

    await handleIssueCommentCommand(context({ octokit }), trigger)

    const body = String(
      (createComment.mock.calls[0]?.[0] as { body?: string })?.body ?? '',
    )
    expect(body).toMatch(commandReplyMarker(555))
    expect(body).toMatch('`/plan` is not configured')
  })

  it('edits the answer another runtime already posted', async () => {
    const { octokit, createComment, updateComment } = harness([
      {
        id: 900,
        body: `${commandReplyMarker(555)}\n@froppa \`/plan\` is not configured for this repository.`,
        user: { login: 'github-actions[bot]', type: 'Bot' },
      },
    ])

    await handleIssueCommentCommand(context({ octokit }), trigger)

    expect(createComment).not.toHaveBeenCalled()
    expect(updateComment).toHaveBeenCalledOnce()
  })

  it('still refuses to edit a human comment carrying the marker', async () => {
    const { octokit, createComment, updateComment } = harness([
      {
        id: 901,
        body: `nice try ${commandReplyMarker(555)}`,
        user: { login: 'a-human' },
      },
    ])

    await handleIssueCommentCommand(context({ octokit }), trigger)

    expect(updateComment).not.toHaveBeenCalled()
    expect(createComment).toHaveBeenCalledOnce()
  })
})
