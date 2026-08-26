import { type BotClients, createBotClients } from '../core/github.js'
import { isRateLimitError } from '../core/lib/rate-limit.js'
import {
  type GithubWebhookHeaders,
  MAX_WEBHOOK_BODY_BYTES,
  registerWebhookHandlers,
  verifyGithubWebhook,
} from '../core/webhooks.js'

export type WorkerEnv = {
  TIDEBOT_APP_ID: string
  TIDEBOT_PRIVATE_KEY: string
  TIDEBOT_WEBHOOK_SECRET: string
  /** Optional comma-separated owner allowlist on top of App installation. */
  TIDEBOT_ALLOWED_OWNERS?: string
}

let ready: Promise<BotClients> | null = null

async function getClients(env: WorkerEnv): Promise<BotClients> {
  if (!ready) {
    const pending = (async () => {
      const clients = await createBotClients({
        appId: env.TIDEBOT_APP_ID,
        privateKey: env.TIDEBOT_PRIVATE_KEY.replace(/\\n/g, '\n'),
        webhookSecret: env.TIDEBOT_WEBHOOK_SECRET,
      })
      registerWebhookHandlers(clients, {
        allowedOwners: env.TIDEBOT_ALLOWED_OWNERS?.split(',')
          .map((owner) => owner.trim())
          .filter(Boolean),
      })
      return clients
    })()
    ready = pending
    pending.catch(() => {
      ready = null
    })
  }

  return ready
}

function webhookHeaders(request: Request): GithubWebhookHeaders {
  return {
    deliveryId: request.headers.get('x-github-delivery') ?? '',
    eventName: request.headers.get('x-github-event') ?? '',
    signature: request.headers.get('x-hub-signature-256') ?? '',
  }
}

function jsonResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

// ponytail: 2 MiB covers every metadata event this bot subscribes to; raise it
// only for a verified GitHub delivery that demonstrably needs more.
async function readWebhookBody(request: Request): Promise<string | null> {
  const contentLength = request.headers.get('content-length')
  if (
    contentLength !== null &&
    (!/^\d+$/.test(contentLength) ||
      Number(contentLength) > MAX_WEBHOOK_BODY_BYTES)
  ) {
    return null
  }

  if (!request.body) {
    return ''
  }

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    length += value.byteLength
    if (length > MAX_WEBHOOK_BODY_BYTES) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }

  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

function logWebhookError(
  message: string,
  error: unknown,
  headers: GithubWebhookHeaders,
): void {
  console.error(
    JSON.stringify({
      message,
      event: headers.eventName,
      delivery: headers.deliveryId,
      error:
        error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : String(error),
    }),
  )
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url)

    // The workers.dev route stays open only for deploy verification; webhook
    // traffic is served exclusively through the protected custom hostname.
    if (
      url.hostname.endsWith('.workers.dev') &&
      !(request.method === 'GET' && url.pathname === '/healthz')
    ) {
      return new Response(null, { status: 404 })
    }

    if (request.method === 'GET' && url.pathname === '/healthz') {
      return new Response('ok', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      })
    }

    if (request.method !== 'POST' || url.pathname !== '/webhooks/github') {
      return new Response(null, { status: 404 })
    }

    const headers = webhookHeaders(request)
    if (!headers.deliveryId || !headers.eventName || !headers.signature) {
      return jsonResponse('{"error":"missing webhook headers"}', 400)
    }

    try {
      const body = await readWebhookBody(request)
      if (body === null) {
        return jsonResponse('{"error":"payload too large"}', 413)
      }

      await verifyGithubWebhook(await getClients(env), body, headers)
      return jsonResponse('{"ok":true}', 200)
    } catch (error: unknown) {
      if (isRateLimitError(error)) {
        logWebhookError('github webhook handler rate limited', error, headers)
        return jsonResponse('{"error":"temporarily unavailable"}', 503)
      }
      logWebhookError('github webhook handler failed', error, headers)
      return jsonResponse('{"error":"internal error"}', 500)
    }
  },
} satisfies ExportedHandler<WorkerEnv>
