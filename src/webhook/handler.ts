// src/webhook/handler.ts

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createHmac } from 'node:crypto';
import { WebhookAuthError } from '../core/errors.js';
import { createLogger } from '../core/logger.js';
import type { WebhookOrchestrator } from './server.js';

const logger = createLogger('WebhookHandler');

/**
 * Zod schema for validating incoming webhook payloads.
 *
 * Sent by the EXIT trap injected into sbatch scripts on job completion.
 */
const WebhookPayloadSchema = z.object({
  /** Slurm job ID */
  jobId: z.string(),
  /** Slurm job name */
  jobName: z.string(),
  /** Job terminal status */
  status: z.enum(['started', 'completed', 'failed', 'timeout']),
  /** Process exit code */
  exitCode: z.number(),
  /** Wall-clock seconds elapsed */
  elapsed: z.number(),
  /** Compute node hostname */
  node: z.string(),
  /** Alchemy internal job UUID (injected as env var in sbatch script) */
  alchemyJobId: z.string().optional(),
  /** HMAC signature of payload (if secret configured) */
  signature: z.string().optional(),
});

export type ValidatedWebhookPayload = z.infer<typeof WebhookPayloadSchema>;

/**
 * Verify HMAC-SHA256 signature of a webhook payload.
 * The signature covers the payload JSON with the signature field removed.
 */
function verifySignature(payload: ValidatedWebhookPayload, secret: string): boolean {
  const { signature, ...rest } = payload;
  if (!signature) return false;
  const expected = createHmac('sha256', secret)
    .update(JSON.stringify(rest))
    .digest('hex');
  return signature === expected;
}

/**
 * Register webhook routes on the Fastify app.
 */
export function registerWebhookHandler(
  app: FastifyInstance,
  orchestrator: WebhookOrchestrator,
  secret?: string,
): void {

  /**
   * POST /api/webhook/job-event
   *
   * Called by the EXIT trap in sbatch scripts on job start/completion/failure.
   *
   * Processing flow:
   * 1. Parse and validate payload with Zod
   * 2. If secret configured, verify HMAC signature
   * 3. Dispatch to orchestrator.handleWebhookEvent()
   * 4. Return 200 OK
   */
  app.post('/api/webhook/job-event', async (request, reply) => {
    // Parse and validate
    const parseResult = WebhookPayloadSchema.safeParse(request.body);
    if (!parseResult.success) {
      logger.warn({ errors: parseResult.error.issues, body: request.body }, 'Invalid webhook payload');
      return reply.status(400).send({
        error: 'Invalid payload',
        details: parseResult.error.issues,
      });
    }

    const payload = parseResult.data;

    logger.info(
      {
        jobId: payload.jobId,
        alchemyJobId: payload.alchemyJobId,
        jobName: payload.jobName,
        status: payload.status,
        exitCode: payload.exitCode,
        elapsed: payload.elapsed,
        node: payload.node,
      },
      'Webhook job event received'
    );

    // HMAC verification (optional, only if secret is configured)
    if (secret) {
      if (!payload.signature) {
        logger.warn({ jobId: payload.jobId }, 'Webhook received without signature but secret is configured');
        // Do not reject — allow unsigned webhooks to pass through (permissive mode)
        // To enforce: throw new WebhookAuthError();
      } else if (!verifySignature(payload, secret)) {
        logger.error({ jobId: payload.jobId }, 'Webhook signature verification failed');
        throw new WebhookAuthError();
      }
    }

    // Dispatch to orchestrator
    try {
      await orchestrator.handleWebhookEvent(payload);
    } catch (err) {
      logger.error({ err, jobId: payload.jobId }, 'Orchestrator failed to handle webhook event');
      return reply.status(500).send({ error: 'Internal server error' });
    }

    return reply.status(200).send({ ok: true });
  });

  /**
   * GET /api/webhook/status
   * Returns webhook server status (useful for health checks from CI/CD).
   */
  app.get('/api/webhook/status', async (_request, reply) => {
    return reply.status(200).send({
      status: 'running',
      timestamp: new Date().toISOString(),
      secretConfigured: !!secret,
    });
  });
}
