import { App } from '@octokit/app'
import { createAppAuth } from '@octokit/auth-app'
import { Octokit } from '@octokit/rest'
import { Webhooks } from '@octokit/webhooks'
import type { RepoRef } from '../types.js'

export type BotClients = {
  app: App
  webhooks: Webhooks
  getInstallationOctokit: (installationId: number) => Promise<Octokit>
  getRepositoryInstallationId: (ref: RepoRef) => Promise<number>
  listInstallationRepositories: (installationId: number) => Promise<RepoRef[]>
}

export type BotCredentials = {
  appId: string
  privateKey: string
  webhookSecret?: string
}

/**
 * GitHub still hands out PKCS#1 keys; the Web Crypto implementations behind
 * `@octokit/auth-app` on non-Node runtimes only accept PKCS#8.
 */
async function normalizePrivateKey(pem: string): Promise<string> {
  if (!pem.includes('BEGIN RSA PRIVATE KEY')) {
    return pem
  }

  const { createPrivateKey } = await import('node:crypto')
  return createPrivateKey({ key: pem, format: 'pem', type: 'pkcs1' }).export({
    type: 'pkcs8',
    format: 'pem',
  }) as string
}

export function credentialsFromEnv(
  env: Record<string, string | undefined> = process.env,
): BotCredentials {
  const appId = env.TIDEBOT_APP_ID
  if (!appId) {
    throw new Error('Set TIDEBOT_APP_ID')
  }

  const privateKey = env.TIDEBOT_PRIVATE_KEY
  if (!privateKey) {
    throw new Error('Set TIDEBOT_PRIVATE_KEY')
  }

  return {
    appId,
    privateKey: privateKey.replace(/\\n/g, '\n'),
    webhookSecret: env.TIDEBOT_WEBHOOK_SECRET,
  }
}

export async function createBotClients(
  credentials: BotCredentials,
): Promise<BotClients> {
  const { appId, webhookSecret } = credentials
  const privateKey = await normalizePrivateKey(credentials.privateKey)

  const app = new App(
    webhookSecret
      ? { appId, privateKey, webhooks: { secret: webhookSecret } }
      : { appId, privateKey },
  )
  const webhooks = webhookSecret
    ? new Webhooks({ secret: webhookSecret })
    : null
  const auth = createAppAuth({ appId, privateKey })

  return {
    app,
    // The webhook secret only verifies inbound deliveries. CLI commands
    // authenticate as the App and never receive one, so this is required where
    // it is used rather than at construction.
    get webhooks(): Webhooks {
      if (!webhooks) {
        throw new Error('Set TIDEBOT_WEBHOOK_SECRET to receive webhooks')
      }
      return webhooks
    },
    getInstallationOctokit: async (installationId: number) => {
      const { token } = await auth({ type: 'installation', installationId })
      return new Octokit({ auth: token })
    },
    getRepositoryInstallationId: async ({ owner, repo }: RepoRef) => {
      const { data } = await app.octokit.request(
        'GET /repos/{owner}/{repo}/installation',
        { owner, repo },
      )
      return data.id
    },
    listInstallationRepositories: async (installationId: number) => {
      const { token } = await auth({ type: 'installation', installationId })
      const octokit = new Octokit({ auth: token })
      const refs: RepoRef[] = []
      const iterator = octokit.paginate.iterator(
        octokit.rest.apps.listReposAccessibleToInstallation,
        { per_page: 100 },
      )
      for await (const { data } of iterator) {
        const repositories = Array.isArray(data)
          ? data
          : ((data as { repositories?: unknown[] }).repositories ?? [])
        for (const repository of repositories as Array<{
          name: string
          owner: { login: string }
        }>) {
          refs.push({ owner: repository.owner.login, repo: repository.name })
        }
      }
      return refs
    },
  }
}
