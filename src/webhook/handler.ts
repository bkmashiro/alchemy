// src/webhook/handler.ts
// Webhook handler — full implementation is Agent B's responsibility.
// Stub provided for compilation.

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { createHmac } from 'node:crypto';
import type { Orchestrator } from '../core/orchestrator.js';

const WebhookPayloadSchema = z.object({
  jobId: z.string(),
  jobName: z.string(),
  status: z.enum(['started', 'completed', 'failed', 'timeout']),
  exitCode: z.number(),
  elapsed: z.number(),
  node: z.string(),
  alchemyJobId: z.string().optional(),
  signature: z.string().optional(),
});

export function registerWebhookHandler(
  app: FastifyInstance,
  orchestrator: Orchestrator,
  secret?: string,
): void {
  app.post('/api/webhook/job-event', async (req: FastifyRequest, reply: FastifyReply) => {
    const parseResult = WebhookPayloadSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.status(400).send({ error: 'Invalid payload' });
    }

    const payload = parseResult.data;

    // HMAC verification (optional)
    if (secret && payload.signature) {
      const { signature, ...rest } = payload;
      const expected = createHmac('sha256', secret)
        .update(JSON.stringify(rest))
        .digest('hex');
      if (signature !== expected) {
        return reply.status(401).send({ error: 'Invalid signature' });
      }
    }

    // Dispatch to orchestrator
    await orchestrator.handleWebhookEvent(payload as never);

    return reply.status(200).send({ ok: true });
  });
}
