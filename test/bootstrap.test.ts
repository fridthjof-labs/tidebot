import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAppFromManifest } from '../src/cli/app.js'
import { diagnose } from '../src/cli/doctor.js'
import {
  detectAreaRules,
  detectCheckNames,
  initRepository,
} from '../src/cli/init.js'
import { syncRepositoryLabels } from '../src/cli/labels.js'
import {
  APP_EVENTS,
  APP_PERMISSIONS,
  appManifest,
  loadManifest,
} from '../src/cli/manifest.js'
import { managedLabels } from '../src/core/config/defaults.js'
import { parseConfig } from '../src/core/config/parse.js'
import { fakeGitHub } from './fake-github.js'
import { config } from './helpers.js'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tidebot-test-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('detectAreaRules', () => {
  it('proposes a rule per workspace package', async () => {
    await mkdir(join(root, 'apps/site'), { recursive: true })
    await mkdir(join(root, 'apps/admin'), { recursive: true })
    await mkdir(join(root, 'infra'), { recursive: true })

    const rules = await detectAreaRules(root)
    expect(rules).toEqual(
      expect.arrayContaining([
        { prefix: 'apps/site/', label: 'area/site' },
        { prefix: 'apps/admin/', label: 'area/admin' },
        { prefix: 'infra/', label: 'area/infra' },
      ]),
    )
  })

  it('is empty for a flat repository', async () => {
    await mkdir(join(root, 'src'), { recursive: true })
    expect(await detectAreaRules(root)).toEqual([])
  })
})

describe('detectCheckNames', () => {
  it('reads check names from the repository workflows', async () => {
    await mkdir(join(root, '.github/workflows'), { recursive: true })
    await writeFile(
      join(root, '.github/workflows/ci.yml'),
      [
        'name: Quality',
        'jobs:',
        '  check:',
        '    name: check',
        '    runs-on: x',
      ].join('\n'),
    )
    expect(await detectCheckNames(root)).toEqual(['check'])
  })

  it('is empty when there are no workflows', async () => {
    expect(await detectCheckNames(root)).toEqual([])
  })
})

describe('initRepository', () => {
  it('writes a config that parses, seeded with detected area rules', async () => {
    await mkdir(join(root, 'apps/site'), { recursive: true })

    const result = await initRepository({
      root,
      withActionsRuntime: false,
      withStaleSweep: false,
      withSignedRebase: false,
      force: false,
    })

    expect(result.written).toContain('.github/tidebot.yaml')
    const raw = await readFile(join(root, '.github/tidebot.yaml'), 'utf8')
    const parsed = parseConfig(raw)
    expect(parsed.area.rules).toContainEqual({
      prefix: 'apps/site/',
      label: 'area/site',
    })
  })

  it('writes the optional workflows only when asked', async () => {
    const result = await initRepository({
      root,
      withActionsRuntime: true,
      withStaleSweep: false,
      withSignedRebase: true,
      force: false,
    })
    expect(result.written).toContain('.github/workflows/tidebot.yml')
    expect(result.written).toContain('.github/workflows/tidebot-rebase.yml')
    expect(result.written).not.toContain('.github/workflows/tidebot-stale.yml')
  })

  it('never overwrites an existing file without --force', async () => {
    await mkdir(join(root, '.github'), { recursive: true })
    await writeFile(
      join(root, '.github/tidebot.yaml'),
      'plugins:\n  tide: false',
    )

    const result = await initRepository({
      root,
      withActionsRuntime: false,
      withStaleSweep: false,
      withSignedRebase: false,
      force: false,
    })
    expect(result.skipped).toContain('.github/tidebot.yaml')
    expect(await readFile(join(root, '.github/tidebot.yaml'), 'utf8')).toMatch(
      'tide: false',
    )
  })
})

describe('syncRepositoryLabels', () => {
  function octokitWith(
    existing: Array<{ name: string; color: string; description: string }>,
  ) {
    const { octokit, spy } = fakeGitHub({ repositoryLabels: existing })
    return {
      octokit,
      createLabel: spy.createLabel,
      updateLabel: spy.updateLabel,
    }
  }

  it('creates the labels the config refers to', async () => {
    const { octokit, createLabel } = octokitWith([])
    const result = await syncRepositoryLabels(
      octokit,
      { owner: 'acme', repo: 'widget' },
      config({ area: { rules: [{ prefix: 'src/', label: 'area/src' }] } }),
    )

    expect(result.created).toContain('lgtm')
    expect(result.created).toContain('size/xs')
    expect(result.created).toContain('area/src')
    expect(result.created).toContain('bug')
    expect(createLabel).toHaveBeenCalled()
  })

  it('creates the dependencies label the dependabot plugin requires', async () => {
    const { octokit } = octokitWith([])
    const result = await syncRepositoryLabels(
      octokit,
      { owner: 'acme', repo: 'widget' },
      config({ plugins: { dependabot: true } }),
    )
    expect(result.created).toContain('dependencies')
  })

  it('leaves the dependencies label alone when nothing needs it', async () => {
    const { octokit } = octokitWith([])
    const result = await syncRepositoryLabels(
      octokit,
      { owner: 'acme', repo: 'widget' },
      config(),
    )
    expect(result.created).not.toContain('dependencies')
  })

  it('leaves a label that already matches alone', async () => {
    const expected = managedLabels(config())
    const { octokit, updateLabel } = octokitWith(expected)
    const result = await syncRepositoryLabels(
      octokit,
      { owner: 'acme', repo: 'widget' },
      config(),
    )
    expect(result.created).toEqual([])
    expect(result.updated).toEqual([])
    expect(updateLabel).not.toHaveBeenCalled()
  })

  it('changes nothing on a dry run', async () => {
    const { octokit, createLabel } = octokitWith([])
    const result = await syncRepositoryLabels(
      octokit,
      { owner: 'acme', repo: 'widget' },
      config(),
      { dryRun: true },
    )
    expect(result.created.length).toBeGreaterThan(0)
    expect(createLabel).not.toHaveBeenCalled()
  })
})

describe('appManifest', () => {
  it('asks for exactly what auto-merge needs, and does not subscribe to status', () => {
    const manifest = appManifest({
      name: 'tidebot',
      webhookUrl: 'https://hooks.example/webhooks/github',
      homepageUrl: 'https://example',
      public: false,
    })
    const permissions = manifest.default_permissions as Record<string, string>
    expect(permissions.pull_requests).toBe('write')
    expect(permissions.contents).toBe('write')
    expect(permissions.actions).toBe('write')
    expect(permissions.deployments).toBe('read')
    expect(manifest.default_events).not.toContain('status')
    expect(manifest.default_events).toContain('issue_comment')
    expect(manifest.default_events).toContain('workflow_run')
  })
})

describe('diagnose', () => {
  function octokit(
    contents: Record<string, string | Array<{ name: string }>> = {},
    labels: string[] = [],
  ) {
    return fakeGitHub({
      contents,
      repositoryLabels: labels.map((name) => ({
        name,
        color: '000000',
        description: '',
      })),
    }).octokit
  }

  it('warns when a repository has no config of its own', async () => {
    const { findings } = await diagnose(octokit(), {
      owner: 'acme',
      repo: 'widget',
    })
    expect(findings.map((finding) => finding.message).join('\n')).toMatch(
      'running on built-in defaults',
    )
  })

  it('reports a missing installation permission as an error', async () => {
    const { findings } = await diagnose(
      octokit(),
      { owner: 'acme', repo: 'widget' },
      { installation: { permissions: { pull_requests: 'read' } } },
    )
    expect(
      findings.some(
        (finding) =>
          finding.level === 'error' &&
          finding.message.includes('pull_requests'),
      ),
    ).toBe(true)
  })

  it('checks the same permissions and events the manifest requests', async () => {
    const { findings } = await diagnose(
      octokit(),
      { owner: 'acme', repo: 'widget' },
      {
        installation: {
          permissions: { ...APP_PERMISSIONS },
          events: [...APP_EVENTS],
        },
      },
    )
    expect(findings.filter((finding) => finding.level === 'error')).toEqual([])
  })

  it('flags a status subscription as a rate-limit risk', async () => {
    const { findings } = await diagnose(
      octokit(),
      { owner: 'acme', repo: 'widget' },
      {
        appEvents: [
          'issue_comment',
          'pull_request',
          'pull_request_review',
          'push',
          'check_suite',
          'status',
        ],
      },
    )
    expect(
      findings.some(
        (finding) =>
          finding.level === 'warn' && finding.message.includes('status'),
      ),
    ).toBe(true)
  })

  it('errors when signed-rebase is on but its workflow is absent', async () => {
    const { findings } = await diagnose(
      octokit({
        '.github/tidebot.yaml':
          'commands:\n  updateBranchMethod: signed-rebase',
      }),
      { owner: 'acme', repo: 'widget' },
    )
    expect(
      findings.some(
        (finding) =>
          finding.level === 'error' &&
          finding.message.includes('tidebot-rebase.yml'),
      ),
    ).toBe(true)
  })
})

describe('diagnose runtime conflicts', () => {
  function octokit(
    contents: Record<string, string | Array<{ name: string }>> = {},
  ) {
    return fakeGitHub({ contents }).octokit
  }

  const ref = { owner: 'acme', repo: 'widget' }
  const workflows = { '.github/workflows': [{ name: 'tidebot.yml' }] }

  it('warns when the App and the in-repo workflow both run', async () => {
    const { findings } = await diagnose(octokit(workflows), ref, {
      installation: { permissions: {}, events: [] },
    })

    expect(
      findings.some((finding) =>
        finding.message.includes('both runtimes will handle every event'),
      ),
    ).toBe(true)
  })

  it('says nothing about the workflow when no App is installed', async () => {
    const { findings } = await diagnose(octokit(workflows), ref)

    expect(
      findings.some((finding) => finding.message.includes('both runtimes')),
    ).toBe(false)
  })
})

describe('loadManifest', () => {
  const secretsOnly = JSON.stringify({
    name: 'fridthjof-labs-tofu',
    url: 'https://github.com/fridthjof-labs/infrastructure',
    default_permissions: { secrets: 'write', metadata: 'read' },
  })

  it('keeps the permissions the file declares and nothing more', () => {
    const manifest = loadManifest(secretsOnly)
    expect(manifest.default_permissions).toEqual({
      secrets: 'write',
      metadata: 'read',
    })
    expect(manifest.default_events).toEqual([])
    expect(manifest.public).toBe(false)
  })

  it('omits hook_attributes for an App with no webhook', () => {
    // GitHub requires hook_attributes.url whenever the block is present, even
    // with active: false, and rejects the manifest with "url wasn't supplied".
    // An App that only holds a credential has no webhook, so the block is
    // absent rather than inactive.
    expect(loadManifest(secretsOnly)).not.toHaveProperty('hook_attributes')
  })

  it('refuses hook_attributes without a url', () => {
    expect(() =>
      loadManifest(
        JSON.stringify({
          name: 'x',
          default_permissions: { secrets: 'write' },
          hook_attributes: { active: false },
        }),
      ),
    ).toThrow('hook_attributes.url is required')
  })

  it('refuses a manifest with no permissions or no name', () => {
    expect(() => loadManifest(JSON.stringify({ name: 'x' }))).toThrow(
      'default_permissions',
    )
    expect(() =>
      loadManifest(
        JSON.stringify({ default_permissions: { secrets: 'write' } }),
      ),
    ).toThrow('name')
  })

  it("refuses a redirect_url, which is the CLI's to set", () => {
    expect(() =>
      loadManifest(
        JSON.stringify({
          name: 'x',
          default_permissions: { secrets: 'write' },
          redirect_url: 'https://elsewhere',
        }),
      ),
    ).toThrow('redirect_url')
  })
})

describe('createAppFromManifest', () => {
  it('needs a webhook URL only when registering Tidebot itself', async () => {
    // A manifest file carries its own hook_attributes, so the flag is not
    // required with one; without one the CLI is registering Tidebot, which
    // cannot work without a webhook.
    await expect(
      createAppFromManifest({
        name: 'tidebot',
        homepageUrl: 'https://example',
        public: false,
        port: 0,
        outFile: '/dev/null',
        open: () => {},
      }),
    ).rejects.toThrow('--webhook-url is required unless --manifest is given')
  })
})
