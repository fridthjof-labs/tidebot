import { Webhooks } from '@octokit/webhooks'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import worker, {
  WebhookDelivery,
  type WebhookQueueMessage,
} from '../src/runtime/worker.js'

const send = vi.fn().mockResolvedValue({})
const processDelivery = vi.fn().mockResolvedValue('processed')
const getByName = vi.fn(() => ({ process: processDelivery }))

const ENV = {
  TIDEBOT_APP_ID: '1',
  TIDEBOT_PRIVATE_KEY: 'unused-in-these-routes',
  TIDEBOT_WEBHOOK_SECRET: 'secret',
  TIDEBOT_WEBHOOK_QUEUE: { send },
  TIDEBOT_WEBHOOK_DELIVERIES: { getByName },
}

async function fetchWorker(url: string, init?: RequestInit): Promise<Response> {
  return worker.fetch(new Request(url, init), ENV as never)
}

describe('worker routing', () => {
  beforeEach(() => {
    send.mockClear()
    processDelivery.mockClear()
    getByName.mockClear()
  })

  it('answers health checks on workers.dev', async () => {
    const response = await fetchWorker('https://x.example.workers.dev/healthz')
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('ok')
  })

  it('refuses webhooks on workers.dev so only the protected hostname serves them', async () => {
    const response = await fetchWorker(
      'https://x.example.workers.dev/webhooks/github',
      { method: 'POST' },
    )
    expect(response.status).toBe(404)
  })

  it('rejects a webhook without GitHub headers before doing any work', async () => {
    const response = await fetchWorker(
      'https://hooks.example.com/webhooks/github',
      {
        method: 'POST',
        body: '{}',
      },
    )
    expect(response.status).toBe(400)
  })

  it('rejects an oversized payload', async () => {
    const response = await fetchWorker(
      'https://hooks.example.com/webhooks/github',
      {
        method: 'POST',
        headers: {
          'x-github-delivery': 'd',
          'x-github-event': 'ping',
          'x-hub-signature-256': 'sha256=x',
          'content-length': String(4 * 1024 * 1024),
        },
        body: '{}',
      },
    )
    expect(response.status).toBe(413)
  })

  it('verifies and enqueues a delivery before acknowledging it', async () => {
    const body = '{}'
    const signature = await new Webhooks({ secret: 'secret' }).sign(body)
    const response = await fetchWorker(
      'https://hooks.example.com/webhooks/github',
      {
        method: 'POST',
        headers: {
          'x-github-delivery': 'delivery-1',
          'x-github-event': 'ping',
          'x-hub-signature-256': signature,
        },
        body,
      },
    )

    expect(response.status).toBe(202)
    expect(send).toHaveBeenCalledWith({
      body,
      headers: {
        deliveryId: 'delivery-1',
        eventName: 'ping',
        signature,
      },
    })
  })

  it('rejects a bad signature without enqueueing it', async () => {
    const response = await fetchWorker(
      'https://hooks.example.com/webhooks/github',
      {
        method: 'POST',
        headers: {
          'x-github-delivery': 'delivery-2',
          'x-github-event': 'ping',
          'x-hub-signature-256': 'sha256=invalid',
        },
        body: '{}',
      },
    )

    expect(response.status).toBe(401)
    expect(send).not.toHaveBeenCalled()
  })

  it('404s an unknown path', async () => {
    expect((await fetchWorker('https://hooks.example.com/nope')).status).toBe(
      404,
    )
  })
})

describe('queued webhook delivery', () => {
  it('acks a successfully coordinated delivery', async () => {
    const ack = vi.fn()
    const retry = vi.fn()
    const body: WebhookQueueMessage = {
      body: '{}',
      headers: {
        deliveryId: 'delivery-3',
        eventName: 'ping',
        signature: 'sha256=verified-at-intake',
      },
    }

    await worker.queue(
      {
        messages: [{ body, attempts: 1, ack, retry }],
      } as never,
      ENV as never,
    )

    expect(getByName).toHaveBeenCalledWith('delivery-3')
    expect(processDelivery).toHaveBeenCalledWith(body)
    expect(ack).toHaveBeenCalledOnce()
    expect(retry).not.toHaveBeenCalled()
  })

  it('persists completion and suppresses a replay of the delivery ID', async () => {
    const values = new Map<string, unknown>()
    const setAlarm = vi.fn().mockResolvedValue(undefined)
    const ctx = {
      storage: {
        transactionSync: <T>(operation: () => T): T => operation(),
        kv: {
          get: (key: string) => values.get(key),
          put: (key: string, value: unknown) => values.set(key, value),
          delete: (key: string) => values.delete(key),
        },
        setAlarm,
        deleteAll: vi.fn().mockResolvedValue(undefined),
      },
    }
    const body = '{}'
    const delivery: WebhookQueueMessage = {
      body,
      headers: {
        deliveryId: 'delivery-4',
        eventName: 'ping',
        signature: await new Webhooks({ secret: 'secret' }).sign(body),
      },
    }
    const object = new WebhookDelivery(ctx as never, ENV as never)

    expect(await object.process(delivery)).toBe('processed')
    expect(await object.process(delivery)).toBe('duplicate')
    expect(setAlarm).toHaveBeenCalledOnce()
  })
})
