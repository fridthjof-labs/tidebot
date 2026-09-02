import { writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { App } from '@octokit/app'
import { Octokit } from '@octokit/rest'
import { appManifest, manifestFormPage } from './manifest.js'

export type CreatedApp = {
  id: number
  slug: string
  name: string
  htmlUrl: string
  pem: string
  webhookSecret: string
  clientId: string
}

function randomState(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Register a GitHub App from a manifest instead of a settings form. GitHub
 * posts the App back as a one-time code, which is exchanged for the App ID,
 * private key, and webhook secret — the three values every runtime needs.
 */
export async function createAppFromManifest(options: {
  org?: string
  name: string
  webhookUrl?: string
  homepageUrl: string
  public: boolean
  port: number
  outFile: string
  open: (url: string) => void
  /** A manifest to register verbatim instead of Tidebot's own. */
  manifest?: Record<string, unknown>
}): Promise<CreatedApp> {
  const state = randomState()
  const actionUrl = options.org
    ? `https://github.com/organizations/${options.org}/settings/apps/new`
    : 'https://github.com/settings/apps/new'

  if (!options.manifest && !options.webhookUrl) {
    throw new Error('--webhook-url is required unless --manifest is given')
  }
  const manifest = {
    ...(options.manifest ??
      appManifest({ ...options, webhookUrl: options.webhookUrl ?? '' })),
    redirect_url: `http://127.0.0.1:${options.port}/callback`,
  }

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(
        request.url ?? '/',
        `http://127.0.0.1:${options.port}`,
      )

      if (url.pathname === '/') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(manifestFormPage(manifest, actionUrl, state))
        return
      }

      if (url.pathname === '/callback') {
        const returnedState = url.searchParams.get('state')
        const returnedCode = url.searchParams.get('code')
        if (returnedState !== state || !returnedCode) {
          response.writeHead(400, { 'content-type': 'text/plain' })
          response.end('Unexpected callback. Start over.')
          return
        }
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(
          '<!doctype html><meta charset="utf-8"><p>App created. Return to your terminal.</p>',
        )
        server.close()
        resolve(returnedCode)
        return
      }

      response.writeHead(404)
      response.end()
    })

    server.on('error', reject)
    server.listen(options.port, '127.0.0.1', () => {
      options.open(`http://127.0.0.1:${options.port}/`)
    })
  })

  const { data } = await new Octokit().request(
    'POST /app-manifests/{code}/conversions',
    { code },
  )

  const created: CreatedApp = {
    id: data.id,
    slug: data.slug ?? '',
    name: data.name,
    htmlUrl: data.html_url,
    pem: data.pem,
    webhookSecret: data.webhook_secret ?? '',
    clientId: data.client_id,
  }

  await writeFile(options.outFile, `${JSON.stringify(created, null, 2)}\n`, {
    mode: 0o600,
  })

  return created
}

export async function describeApp(app: App): Promise<{
  id: number
  slug: string
  name: string
  events: string[]
  permissions: Record<string, string>
  installations: Array<{
    id: number
    account: string
    repositorySelection: 'all' | 'selected'
  }>
}> {
  const { data } = await app.octokit.request('GET /app')
  if (!data) {
    throw new Error(
      'GET /app returned no App; check TIDEBOT_APP_ID and the private key',
    )
  }
  const { data: installations } = await app.octokit.request(
    'GET /app/installations',
    { per_page: 100 },
  )

  return {
    id: data.id,
    slug: data.slug ?? '',
    name: data.name,
    events: data.events ?? [],
    permissions: (data.permissions ?? {}) as Record<string, string>,
    installations: installations.map((installation) => ({
      id: installation.id,
      account:
        (installation.account && 'login' in installation.account
          ? installation.account.login
          : null) ?? 'unknown',
      repositorySelection: installation.repository_selection,
    })),
  }
}
