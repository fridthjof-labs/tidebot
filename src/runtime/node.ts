import { createServer } from 'node:http'
import type { BotClients } from '../core/github.js'
import { isRateLimitError } from '../core/lib/rate-limit.js'
import {
  MAX_WEBHOOK_BODY_BYTES,
  registerWebhookHandlers,
  verifyGithubWebhook,
  type WebhookOptions,
} from '../core/webhooks.js'

class WebhookPayloadTooLargeError extends Error {}

async function readBody(
  request: import('node:http').IncomingMessage,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let length = 0
    request.on('data', (chunk) => {
      const buffer = Buffer.from(chunk)
      length += buffer.byteLength
      if (length > MAX_WEBHOOK_BODY_BYTES) {
        reject(new WebhookPayloadTooLargeError())
        request.removeAllListeners('data')
        request.resume()
        return
      }
      chunks.push(buffer)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

export function createWebhookServer(
  clients: BotClients,
  options: WebhookOptions = {},
): ReturnType<typeof createServer> {
  registerWebhookHandlers(clients, options)

  return createServer(async (request, response) => {
    const json = (status: number, body: string): void => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(body)
    }

    try {
      if (request.method === 'GET' && request.url === '/healthz') {
        response.writeHead(200, { 'content-type': 'text/plain' })
        response.end('ok')
        return
      }

      if (request.method !== 'POST' || request.url !== '/webhooks/github') {
        response.writeHead(404)
        response.end()
        return
      }

      const deliveryId = String(request.headers['x-github-delivery'] ?? '')
      const eventName = String(request.headers['x-github-event'] ?? '')
      const signature = String(request.headers['x-hub-signature-256'] ?? '')
      if (!deliveryId || !eventName || !signature) {
        json(400, '{"error":"missing webhook headers"}')
        return
      }

      const contentLength = request.headers['content-length']
      if (
        contentLength !== undefined &&
        (!/^\d+$/.test(contentLength) ||
          Number(contentLength) > MAX_WEBHOOK_BODY_BYTES)
      ) {
        json(413, '{"error":"payload too large"}')
        return
      }

      await verifyGithubWebhook(clients, await readBody(request), {
        deliveryId,
        eventName,
        signature,
      })
      json(200, '{"ok":true}')
    } catch (error) {
      if (error instanceof WebhookPayloadTooLargeError) {
        json(413, '{"error":"payload too large"}')
        return
      }
      if (isRateLimitError(error)) {
        console.error('github webhook handler rate limited', error)
        json(503, '{"error":"temporarily unavailable"}')
        return
      }
      console.error('github webhook handler failed', error)
      json(500, '{"error":"internal error"}')
    }
  })
}

export function startWebhookServer(
  clients: BotClients,
  options: WebhookOptions = {},
  port = Number(process.env.PORT ?? 3000),
): ReturnType<typeof createServer> {
  const server = createWebhookServer(clients, options)
  server.listen(port, () => {
    console.log(`tidebot listening on :${port}`)
  })
  return server
}
