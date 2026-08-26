import { describe, expect, it } from 'vitest'
import worker from '../src/runtime/worker.js'

const ENV = {
  TIDEBOT_APP_ID: '1',
  TIDEBOT_PRIVATE_KEY: 'unused-in-these-routes',
  TIDEBOT_WEBHOOK_SECRET: 'secret',
}

async function fetchWorker(url: string, init?: RequestInit): Promise<Response> {
  return worker.fetch(new Request(url, init), ENV)
}

describe('worker routing', () => {
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

  it('404s an unknown path', async () => {
    expect((await fetchWorker('https://hooks.example.com/nope')).status).toBe(
      404,
    )
  })
})
