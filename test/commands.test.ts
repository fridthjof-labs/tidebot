import { describe, expect, it } from 'vitest'
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
})

describe('isBotComment', () => {
  it('recognises any app login, not one hard-coded name', () => {
    expect(isBotComment('tidebot[bot]')).toBe(true)
    expect(isBotComment('some-other-app[bot]')).toBe(true)
    expect(isBotComment('a-human')).toBe(false)
    expect(isBotComment(null)).toBe(false)
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
