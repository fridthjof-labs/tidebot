import { DurableObject } from 'cloudflare:workers'
import { type BotClients, createBotClients } from '../core/github.js'
import { readTextWithLimit } from '../core/lib/body.js'
import {
  type GithubWebhookHeaders,
  GithubWebhookSignatureError,
  MAX_WEBHOOK_BODY_BYTES,
  registerWebhookHandlers,
  verifyGithubWebhook,
  verifyGithubWebhookSignature,
} from '../core/webhooks.js'

export type WebhookQueueMessage = {
  body: string
  headers: GithubWebhookHeaders
}

type RuntimeEnv = Omit<
  WorkerEnv,
  'TIDEBOT_ALLOWED_OWNERS' | 'TIDEBOT_WEBHOOK_QUEUE'
> & {
  TIDEBOT_ALLOWED_OWNERS?: string
  TIDEBOT_WEBHOOK_QUEUE: Queue<WebhookQueueMessage>
}

let ready: Promise<BotClients> | null = null

async function getClients(env: RuntimeEnv): Promise<BotClients> {
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

type DeliveryState =
  | { status: 'processing'; attemptId: string; startedAt: number }
  | { status: 'complete'; completedAt: number }

const DELIVERY_STATE_KEY = 'delivery'
const PROCESSING_LEASE_MS = 15 * 60 * 1000
const DELIVERY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/**
 * One object coordinates one GitHub delivery ID. Queues are at-least-once, so
 * retries must not run the same App event concurrently or replay a completed
 * delivery. The lease recovers a delivery after an unexpected Worker stop.
 */
export class WebhookDelivery extends DurableObject<RuntimeEnv> {
  async process(
    delivery: WebhookQueueMessage,
  ): Promise<'processed' | 'duplicate'> {
    const startedAt = Date.now()
    const attemptId = crypto.randomUUID()
    const decision = this.ctx.storage.transactionSync(() => {
      const current = this.ctx.storage.kv.get<DeliveryState>(DELIVERY_STATE_KEY)
      if (current?.status === 'complete') {
        return 'duplicate' as const
      }
      if (
        current?.status === 'processing' &&
        startedAt - current.startedAt < PROCESSING_LEASE_MS
      ) {
        return 'busy' as const
      }
      this.ctx.storage.kv.put<DeliveryState>(DELIVERY_STATE_KEY, {
        status: 'processing',
        attemptId,
        startedAt,
      })
      return 'process' as const
    })

    if (decision === 'duplicate') {
      return 'duplicate'
    }
    if (decision === 'busy') {
      throw new Error('GitHub webhook delivery is already processing')
    }

    try {
      await verifyGithubWebhook(
        await getClients(this.env),
        delivery.body,
        delivery.headers,
      )
      await this.ctx.storage.setAlarm(Date.now() + DELIVERY_RETENTION_MS)
      this.ctx.storage.transactionSync(() => {
        const current =
          this.ctx.storage.kv.get<DeliveryState>(DELIVERY_STATE_KEY)
        if (
          current?.status !== 'processing' ||
          current.attemptId !== attemptId
        ) {
          throw new Error('GitHub webhook delivery lease expired')
        }
        this.ctx.storage.kv.put<DeliveryState>(DELIVERY_STATE_KEY, {
          status: 'complete',
          completedAt: Date.now(),
        })
      })
      return 'processed'
    } catch (error: unknown) {
      this.ctx.storage.transactionSync(() => {
        const current =
          this.ctx.storage.kv.get<DeliveryState>(DELIVERY_STATE_KEY)
        if (
          current?.status === 'processing' &&
          current.attemptId === attemptId
        ) {
          this.ctx.storage.kv.delete(DELIVERY_STATE_KEY)
        }
      })
      throw error
    }
  }

  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll()
  }
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
  return readTextWithLimit(
    request.body,
    request.headers.get('content-length'),
    MAX_WEBHOOK_BODY_BYTES,
  )
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
  async fetch(request: Request, env: RuntimeEnv): Promise<Response> {
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

      await verifyGithubWebhookSignature(
        await getClients(env),
        body,
        headers.signature,
      )
      await env.TIDEBOT_WEBHOOK_QUEUE.send({ body, headers })
      return jsonResponse('{"accepted":true}', 202)
    } catch (error: unknown) {
      if (error instanceof GithubWebhookSignatureError) {
        logWebhookError('github webhook signature rejected', error, headers)
        return jsonResponse('{"error":"invalid signature"}', 401)
      }
      logWebhookError('github webhook intake failed', error, headers)
      return jsonResponse('{"error":"internal error"}', 500)
    }
  },

  async queue(
    batch: MessageBatch<WebhookQueueMessage>,
    env: RuntimeEnv,
  ): Promise<void> {
    await Promise.all(
      batch.messages.map(async (message) => {
        try {
          const stub = env.TIDEBOT_WEBHOOK_DELIVERIES.getByName(
            message.body.headers.deliveryId,
          )
          const result = await stub.process(message.body)
          message.ack()
          console.log(
            JSON.stringify({
              message: 'github webhook delivery handled',
              event: message.body.headers.eventName,
              delivery: message.body.headers.deliveryId,
              result,
              attempt: message.attempts,
            }),
          )
        } catch (error: unknown) {
          logWebhookError(
            'github webhook delivery failed',
            error,
            message.body.headers,
          )
          message.retry()
        }
      }),
    )
  },
} satisfies ExportedHandler<RuntimeEnv, WebhookQueueMessage>
