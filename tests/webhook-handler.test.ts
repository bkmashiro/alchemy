// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { createHmac } from 'node:crypto'
import { registerWebhookHandler } from '../src/webhook/handler.js'
import type { WebhookOrchestrator } from '../src/webhook/server.js'

function buildPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    jobId: 'slurm-123',
    jobName: 'test-job',
    status: 'completed',
    exitCode: 0,
    elapsed: 60,
    node: 'gpu-node-01',
    ...overrides,
  }
}

function makeSignature(payload: Record<string, unknown>, secret: string): string {
  const { signature: _sig, ...rest } = payload
  return createHmac('sha256', secret).update(JSON.stringify(rest)).digest('hex')
}

async function buildApp(orchestrator: WebhookOrchestrator, secret?: string) {
  const app = Fastify({ logger: false })

  // Map WebhookAuthError → 401 (mirroring what a production server would do)
  app.setErrorHandler((error, _request, reply) => {
    if (error.message === 'Webhook signature verification failed') {
      return reply.status(401).send({ error: error.message })
    }
    return reply.status(500).send({ error: 'Internal server error' })
  })

  registerWebhookHandler(app, orchestrator, secret)
  await app.ready()
  return app
}

describe('POST /api/webhook/job-event', () => {
  let orchestrator: WebhookOrchestrator
  let handleWebhookEvent: ReturnType<typeof vi.fn>

  beforeEach(() => {
    handleWebhookEvent = vi.fn().mockResolvedValue(undefined)
    orchestrator = { handleWebhookEvent }
  })

  it('valid payload → 200 OK', async () => {
    const app = await buildApp(orchestrator)
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhook/job-event',
      payload: buildPayload(),
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ ok: true })
    expect(handleWebhookEvent).toHaveBeenCalledOnce()
  })

  it('missing required field (jobId) → 400', async () => {
    const app = await buildApp(orchestrator)
    const payload = buildPayload()
    delete payload['jobId']
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhook/job-event',
      payload,
    })
    expect(res.statusCode).toBe(400)
    expect(handleWebhookEvent).not.toHaveBeenCalled()
  })

  it('missing required field (status) → 400', async () => {
    const app = await buildApp(orchestrator)
    const payload = buildPayload()
    delete payload['status']
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhook/job-event',
      payload,
    })
    expect(res.statusCode).toBe(400)
  })

  it('unknown status enum value → 400', async () => {
    const app = await buildApp(orchestrator)
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhook/job-event',
      payload: buildPayload({ status: 'invalid_status' }),
    })
    expect(res.statusCode).toBe(400)
  })

  it('missing exitCode (non-number) → 400', async () => {
    const app = await buildApp(orchestrator)
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhook/job-event',
      payload: buildPayload({ exitCode: 'not-a-number' }),
    })
    expect(res.statusCode).toBe(400)
  })

  it('optional alchemyJobId is passed through', async () => {
    const app = await buildApp(orchestrator)
    const payload = buildPayload({ alchemyJobId: 'alchemy-uuid-abc' })
    await app.inject({
      method: 'POST',
      url: '/api/webhook/job-event',
      payload,
    })
    expect(handleWebhookEvent).toHaveBeenCalledWith(
      expect.objectContaining({ alchemyJobId: 'alchemy-uuid-abc' })
    )
  })

  it('orchestrator called with correct data shape', async () => {
    const app = await buildApp(orchestrator)
    const payload = buildPayload({ alchemyJobId: 'alchemy-abc' })
    await app.inject({
      method: 'POST',
      url: '/api/webhook/job-event',
      payload,
    })
    const arg = handleWebhookEvent.mock.calls[0]?.[0]
    expect(arg).toMatchObject({
      jobId: 'slurm-123',
      jobName: 'test-job',
      status: 'completed',
      exitCode: 0,
      elapsed: 60,
      node: 'gpu-node-01',
      alchemyJobId: 'alchemy-abc',
    })
  })

  it('valid all status enum values are accepted', async () => {
    const app = await buildApp(orchestrator)
    for (const status of ['started', 'completed', 'failed', 'timeout']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/webhook/job-event',
        payload: buildPayload({ status }),
      })
      expect(res.statusCode).toBe(200)
    }
  })
})

describe('POST /api/webhook/job-event - HMAC auth', () => {
  const SECRET = 'my-webhook-secret'
  let orchestrator: WebhookOrchestrator
  let handleWebhookEvent: ReturnType<typeof vi.fn>

  beforeEach(() => {
    handleWebhookEvent = vi.fn().mockResolvedValue(undefined)
    orchestrator = { handleWebhookEvent }
  })

  it('correct HMAC signature → 200', async () => {
    const app = await buildApp(orchestrator, SECRET)
    const payload = buildPayload()
    const sig = makeSignature(payload, SECRET)
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhook/job-event',
      payload: { ...payload, signature: sig },
    })
    expect(res.statusCode).toBe(200)
    expect(handleWebhookEvent).toHaveBeenCalledOnce()
  })

  it('wrong HMAC signature → 401', async () => {
    const app = await buildApp(orchestrator, SECRET)
    const payload = buildPayload()
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhook/job-event',
      payload: { ...payload, signature: 'deadbeef' },
    })
    expect(res.statusCode).toBe(401)
    expect(handleWebhookEvent).not.toHaveBeenCalled()
  })

  it('no signature with secret configured → permissive (200)', async () => {
    // Current implementation allows unsigned when secret is set (permissive mode)
    const app = await buildApp(orchestrator, SECRET)
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhook/job-event',
      payload: buildPayload(),
    })
    expect(res.statusCode).toBe(200)
  })

  it('no secret configured → any payload accepted (no auth check)', async () => {
    const app = await buildApp(orchestrator, undefined)
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhook/job-event',
      payload: buildPayload(),
    })
    expect(res.statusCode).toBe(200)
  })
})

describe('GET /api/webhook/status', () => {
  it('returns 200 with status info', async () => {
    const orchestrator = { handleWebhookEvent: vi.fn().mockResolvedValue(undefined) }
    const app = await buildApp(orchestrator, 'secret')
    const res = await app.inject({ method: 'GET', url: '/api/webhook/status' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.status).toBe('running')
    expect(body.secretConfigured).toBe(true)
    expect(typeof body.timestamp).toBe('string')
  })

  it('secretConfigured is false when no secret', async () => {
    const orchestrator = { handleWebhookEvent: vi.fn().mockResolvedValue(undefined) }
    const app = await buildApp(orchestrator, undefined)
    const res = await app.inject({ method: 'GET', url: '/api/webhook/status' })
    const body = JSON.parse(res.body)
    expect(body.secretConfigured).toBe(false)
  })
})
