// src/webhook/server.ts
// Webhook receiver server — full implementation is Agent B's responsibility.
// This stub provides enough for the webhook CLI command to compile.

import Fastify, { type FastifyInstance } from 'fastify';
import { registerWebhookHandler } from './handler.js';
import type { Orchestrator } from '../core/orchestrator.js';

/**
 * Create and start the webhook receiver server.
 *
 * Endpoints:
 *   POST /api/webhook/job-event   — main webhook endpoint
 *   GET  /health                  — health check
 */
export async function createWebhookServer(
  orchestrator: Orchestrator,
  port: number,
  secret?: string,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: 'info' } });

  registerWebhookHandler(app, orchestrator, secret);

  app.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

  await app.listen({ port, host: '0.0.0.0' });
  return app;
}
