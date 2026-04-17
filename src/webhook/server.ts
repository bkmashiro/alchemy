// src/webhook/server.ts

import Fastify from 'fastify';
import { registerWebhookHandler } from './handler.js';
import { createLogger } from '../core/logger.js';

const logger = createLogger('WebhookServer');

/**
 * Minimal interface for the Orchestrator that the webhook handler needs.
 * The full Orchestrator is implemented by Agent A.
 */
export interface WebhookOrchestrator {
  handleWebhookEvent(payload: unknown): Promise<void>;
}

/**
 * Create and start the webhook receiver server.
 *
 * This server runs independently (separate process from the dashboard).
 * It receives POST requests from the curl commands injected into sbatch scripts.
 *
 * Endpoints:
 *   POST /api/webhook/job-event   — main webhook endpoint
 *   GET  /health                  — health check
 */
export async function createWebhookServer(
  orchestrator: WebhookOrchestrator,
  port: number,
  secret?: string,
): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify({ logger: true });

  registerWebhookHandler(app, orchestrator, secret);

  app.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
  }));

  await app.listen({ port, host: '0.0.0.0' });
  logger.info({ port }, 'Webhook server listening');

  return app;
}
