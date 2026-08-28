import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BotClients } from '../src/core/github.js'
import type { GithubWebhookHeaders } from '../src/core/webhooks.js'
import { startWebhookServer } from '../src/runtime/node.js'

const verifyAndReceive = vi.fn()
const webhooks = {
  on: vi.fn(),
  onError: vi.fn(),
  verifyAndReceive,
}

const clients = { webhooks } as unknown as BotClients

let server: ReturnType<typeof startWebhookServer>
let origin: string

const missingHeaderCases: Array<[string, Partial<GithubWebhookHeaders>]> = [
  ['delivery ID', { eventName: 'push', signature: 'sha256=test' }],
  ['event name', { deliveryId: 'delivery', signature: 'sha256=test' }],
  ['signature', { deliveryId: 'delivery', eventName: 'push' }],
]

beforeEach(async () => {
  vi.clearAllMocks()
  server = startWebhookServer(clients, {}, 0)
  await once(server, 'listening')
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  server.close()
  await once(server, 'close')
})

describe('Node webhook runtime', () => {
  it('serves health without entering the webhook boundary', async () => {
    const response = await fetch(`${origin}/healthz`)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('ok')
    expect(verifyAndReceive).not.toHaveBeenCalled()
  })

  it('rejects non-webhook routes without entering the webhook boundary', async () => {
    const response = await fetch(`${origin}/not-a-webhook`, { method: 'POST' })

    expect(response.status).toBe(404)
    expect(verifyAndReceive).not.toHaveBeenCalled()
  })

  it.each(missingHeaderCases)(
    'rejects a missing %s before dispatch',
    async (_name, headers) => {
      const response = await fetch(`${origin}/webhooks/github`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(headers.deliveryId
            ? { 'x-github-delivery': headers.deliveryId }
            : {}),
          ...(headers.eventName ? { 'x-github-event': headers.eventName } : {}),
          ...(headers.signature
            ? { 'x-hub-signature-256': headers.signature }
            : {}),
        },
        body: '{}',
      })

      expect(response.status).toBe(400)
      expect(verifyAndReceive).not.toHaveBeenCalled()
    },
  )

  it('dispatches only through Octokit signature verification', async () => {
    verifyAndReceive.mockResolvedValue(undefined)

    const response = await fetch(`${origin}/webhooks/github`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': 'delivery',
        'x-github-event': 'push',
        'x-hub-signature-256': 'sha256=test',
      },
      body: '{"ok":true}',
    })

    expect(response.status).toBe(200)
    expect(verifyAndReceive).toHaveBeenCalledWith({
      id: 'delivery',
      name: 'push',
      signature: 'sha256=test',
      payload: '{"ok":true}',
    })
  })
})
