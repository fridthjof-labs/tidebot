#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Octokit } from '@octokit/rest'
import { buildContext } from '../core/bot.js'
import { loadRepositoryConfig } from '../core/config/load.js'
import {
  type BotClients,
  createBotClients,
  credentialsFromEnv,
} from '../core/github.js'
import type { BotIdentity } from '../core/identity.js'
import { resolveBotIdentity } from '../core/identity.js'
import { GLYPH } from '../core/lib/glyphs.js'
import { sweepStalePullRequests } from '../core/plugins/stale.js'
import type { RepoRef } from '../core/types.js'
import { runFromActionEnv } from '../runtime/action.js'
import { startWebhookServer } from '../runtime/node.js'
import { createAppFromManifest, describeApp } from './app.js'
import {
  type Args,
  boolFlag,
  flag,
  parseArgs,
  parseRepoFlag,
  requireFlag,
} from './args.js'
import { diagnose } from './doctor.js'
import { initRepository } from './init.js'
import { generateSigningKey } from './keygen.js'
import { syncRepositoryLabels } from './labels.js'
import { loadManifest } from './manifest.js'

const USAGE = `tidebot — Prow-inspired GitHub automation, no Kubernetes required

Runtimes
  serve                       Run the webhook receiver (Node)
  run                         Handle one $GITHUB_EVENT_PATH event (GitHub Actions)
  stale-sweep --repo O/R      Apply stale rules to every open PR

Bootstrap
  app create --org O --webhook-url URL [--name N] [--public] [--port P]
  app create --org O --manifest FILE [--out FILE] [--port P]
      Register any App from a manifest file, such as an infrastructure
      root's Secrets-only App. Its permissions stay in the reviewed file.
                              Register the GitHub App from a manifest
  app show                    Show the App this environment is configured as
  init [--dir .] [--actions] [--stale] [--signed-rebase] [--force]
                              Write .github/tidebot.yaml and optional workflows
  labels --repo O/R [--dry-run]
                              Create the labels the config refers to
  doctor --repo O/R           Explain why an installation is not behaving
  keygen --name N --email E [--passphrase P] [--out PREFIX]
                              Generate the signed-rebase signing key

Environment
  TIDEBOT_APP_ID, TIDEBOT_PRIVATE_KEY, TIDEBOT_WEBHOOK_SECRET
  GITHUB_TOKEN            used by labels/doctor/config/stale-sweep when no App
                          is configured, so a repository can be set up first
  TIDEBOT_ALLOWED_OWNERS  optional comma-separated owner allowlist
  PORT                    webhook port for \`serve\` (default 3000)
`

async function clients(): Promise<BotClients> {
  return createBotClients(credentialsFromEnv())
}

function hasAppCredentials(): boolean {
  return Boolean(process.env.TIDEBOT_APP_ID && process.env.TIDEBOT_PRIVATE_KEY)
}

/** Stand-in identity when acting through a plain token rather than an App. */
const TOKEN_IDENTITY: BotIdentity = {
  appId: 0,
  slug: 'tidebot',
  name: 'Tidebot',
  login: 'github-actions[bot]',
}

/**
 * Authenticate as the App when it is configured, and fall back to a plain
 * token otherwise. `labels`, `doctor`, and `config` are the setup path for a
 * repository that has no App at all, so requiring one to run them would leave
 * the zero-infrastructure install with no way to bootstrap itself.
 */
async function contextFor(ref: RepoRef): Promise<{
  botClients: BotClients | null
  installationId: number | null
  ctx: Awaited<ReturnType<typeof buildContext>>
}> {
  if (!hasAppCredentials()) {
    const token =
      process.env.TIDEBOT_TOKEN ??
      process.env.GITHUB_TOKEN ??
      process.env.GH_TOKEN
    if (!token) {
      throw new Error(
        'Set TIDEBOT_APP_ID and TIDEBOT_PRIVATE_KEY, or GITHUB_TOKEN, to reach the GitHub API',
      )
    }
    return {
      botClients: null,
      installationId: null,
      ctx: await buildContext({
        octokit: new Octokit({ auth: token }),
        ref,
        identity: TOKEN_IDENTITY,
      }),
    }
  }

  const botClients = await clients()
  const installationId = await botClients.getRepositoryInstallationId(ref)
  const octokit = await botClients.getInstallationOctokit(installationId)
  return {
    botClients,
    installationId,
    ctx: await buildContext({
      octokit,
      ref,
      identity: await resolveBotIdentity(botClients.app),
    }),
  }
}

function openInBrowser(url: string): void {
  const command =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'start'
        : 'xdg-open'
  execFile(command, [url], (error) => {
    if (error) {
      console.log(`Open this URL to continue:\n  ${url}`)
    }
  })
  console.log(`If your browser did not open, go to:\n  ${url}`)
}

async function commandServe(): Promise<void> {
  const allowedOwners = process.env.TIDEBOT_ALLOWED_OWNERS?.split(',')
    .map((owner) => owner.trim())
    .filter(Boolean)
  startWebhookServer(await clients(), { allowedOwners })
}

async function commandStaleSweep(args: Args): Promise<void> {
  const ref = parseRepoFlag(requireFlag(args, 'repo'))
  const { ctx } = await contextFor(ref)
  const processed = await sweepStalePullRequests(ctx)
  console.log(
    `stale-sweep processed ${processed} open PR(s) in ${ref.owner}/${ref.repo}`,
  )
}

async function commandInit(args: Args): Promise<void> {
  const root = resolve(flag(args, 'dir') ?? process.cwd())
  const result = await initRepository({
    root,
    withActionsRuntime: boolFlag(args, 'actions'),
    withStaleSweep: boolFlag(args, 'stale'),
    withSignedRebase: boolFlag(args, 'signed-rebase'),
    force: boolFlag(args, 'force'),
  })

  for (const file of result.written) {
    console.log(`wrote    ${file}`)
  }
  for (const file of result.skipped) {
    console.log(`exists   ${file} (use --force to overwrite)`)
  }
  console.log(
    '\nReview .github/tidebot.yaml, then run:\n  tidebot labels --repo <owner>/<repo>',
  )
}

async function commandLabels(args: Args): Promise<void> {
  const ref = parseRepoFlag(requireFlag(args, 'repo'))
  const { ctx } = await contextFor(ref)
  const result = await syncRepositoryLabels(ctx.octokit, ref, ctx.config, {
    dryRun: boolFlag(args, 'dry-run'),
  })

  const prefix = boolFlag(args, 'dry-run') ? 'would ' : ''
  console.log(`${prefix}create   ${result.created.join(', ') || GLYPH.none}`)
  console.log(`${prefix}update   ${result.updated.join(', ') || GLYPH.none}`)
  console.log(`unchanged  ${result.unchanged.length}`)
}

async function commandDoctor(args: Args): Promise<void> {
  const ref = parseRepoFlag(requireFlag(args, 'repo'))
  const { botClients, installationId, ctx } = await contextFor(ref)

  // Without App credentials the config and label checks still run; the
  // permission and event checks simply have nothing to inspect.
  const app = botClients ? await describeApp(botClients.app) : null
  const installation =
    botClients && installationId
      ? (
          await botClients.app.octokit.request(
            'GET /app/installations/{installation_id}',
            { installation_id: installationId },
          )
        ).data
      : null

  const { findings } = await diagnose(ctx.octokit, ref, {
    installation: installation
      ? {
          permissions: installation.permissions as unknown as Record<
            string,
            string
          >,
          events: installation.events,
        }
      : undefined,
    appEvents: app?.events,
  })

  console.log(
    app
      ? `App        ${app.name} (${app.slug}, id ${app.id})`
      : 'App        none — checked with a plain token',
  )
  console.log(
    `Repository ${ref.owner}/${ref.repo}${installationId ? ` (installation ${installationId})` : ''}\n`,
  )

  const icon = {
    ok: GLYPH.passed,
    warn: `${GLYPH.warning} `,
    error: GLYPH.failed,
  }
  for (const finding of findings) {
    console.log(`${icon[finding.level]} ${finding.message}`)
  }

  if (findings.some((finding) => finding.level === 'error')) {
    process.exitCode = 1
  }
}

async function commandApp(args: Args): Promise<void> {
  const subcommand = args.positional[0] ?? 'show'

  if (subcommand === 'show') {
    const app = await describeApp((await clients()).app)
    console.log(JSON.stringify(app, null, 2))
    return
  }

  if (subcommand !== 'create') {
    throw new Error(`Unknown "app" subcommand "${subcommand}"`)
  }

  const manifestPath = flag(args, 'manifest')
  const manifest = manifestPath
    ? loadManifest(await readFile(resolve(manifestPath), 'utf8'))
    : undefined
  const outFile = resolve(
    flag(args, 'out') ??
      (typeof manifest?.name === 'string'
        ? `${manifest.name}-app.json`
        : 'tidebot-app.json'),
  )
  const created = await createAppFromManifest({
    org: flag(args, 'org'),
    name: flag(args, 'name') ?? 'tidebot',
    webhookUrl: manifest
      ? flag(args, 'webhook-url')
      : requireFlag(args, 'webhook-url'),
    manifest,
    homepageUrl:
      flag(args, 'homepage') ?? 'https://github.com/fridthjof-labs/tidebot',
    public: boolFlag(args, 'public'),
    port: Number(flag(args, 'port') ?? 8787),
    outFile,
    open: openInBrowser,
  })

  console.log(`\nCreated ${created.name} (${created.htmlUrl})`)
  console.log(
    `Credentials written to ${outFile} (mode 600 — do not commit it).\n`,
  )
  console.log('Set these where the bot runs:')
  console.log(`  TIDEBOT_APP_ID=${created.id}`)
  console.log('  TIDEBOT_PRIVATE_KEY=<the "pem" field>')
  console.log('  TIDEBOT_WEBHOOK_SECRET=<the "webhookSecret" field>\n')
  console.log(`Then install it: ${created.htmlUrl}/installations/new`)
}

async function commandKeygen(args: Args): Promise<void> {
  const name = requireFlag(args, 'name')
  const email = requireFlag(args, 'email')
  const prefix = flag(args, 'out') ?? 'tidebot-signing-key'
  const key = await generateSigningKey({
    name,
    email,
    passphrase: flag(args, 'passphrase'),
  })

  await writeFile(`${prefix}.pub.asc`, key.publicKey, { mode: 0o600 })
  await writeFile(`${prefix}.asc`, key.privateKey, { mode: 0o600 })

  console.log(`Key ${key.keyId} generated for ${name} <${email}>.\n`)
  console.log('1. Sign in as the machine user and verify that email address.')
  console.log(`2. Add ${prefix}.pub.asc at https://github.com/settings/gpg/new`)
  console.log(`3. Add ${prefix}.asc as the TIDEBOT_GPG_PRIVATE_KEY secret`)
  if (flag(args, 'passphrase')) {
    console.log('4. Add the passphrase as the TIDEBOT_GPG_PASSPHRASE secret')
  }
  console.log(
    `\nAlso set the repository variables TIDEBOT_GIT_USER_NAME=${name} and TIDEBOT_GIT_USER_EMAIL=${email}.`,
  )
  console.log('Delete both local files once the secrets are in place.')
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  switch (args.command) {
    case 'serve':
      return commandServe()
    case 'run':
      return runFromActionEnv()
    case 'stale-sweep':
      return commandStaleSweep(args)
    case 'init':
      return commandInit(args)
    case 'labels':
      return commandLabels(args)
    case 'doctor':
      return commandDoctor(args)
    case 'app':
      return commandApp(args)
    case 'keygen':
      return commandKeygen(args)
    case 'config': {
      const ref = parseRepoFlag(requireFlag(args, 'repo'))
      const { ctx } = await contextFor(ref)
      const loaded = await loadRepositoryConfig(ctx.octokit, ref)
      console.log(JSON.stringify(loaded, null, 2))
      return
    }
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE)
      return
    default:
      console.error(`Unknown command "${args.command}"\n`)
      console.log(USAGE)
      process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
