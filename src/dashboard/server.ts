// src/dashboard/server.ts
// HTTP server serving static files + REST API for the Alchemy dashboard.

import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerApiRoutes } from './api.js';
import { JobRegistry } from '../core/registry.js';
import type { BaseExecutor } from '../executors/base.js';
import type { Scheduler } from '../core/scheduler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Create and configure the dashboard Fastify server.
 *
 * Serves:
 * - /            → public/index.html (SPA dashboard)
 * - /app.js      → public/app.js
 * - /api/*       → REST API routes
 */
export async function createDashboardServer(
  registry: JobRegistry,
  port: number,
  executors?: BaseExecutor | Map<string, BaseExecutor>,
  scheduler?: Scheduler,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: 'warn',
    },
  });

  await app.register(fastifyCors, { origin: true });

  // Serve static files from public/ directory (no-cache for dev agility)
  await app.register(fastifyStatic, {
    root: join(__dirname, 'public'),
    prefix: '/',
    cacheControl: false,
    setHeaders(res) {
      res.setHeader('Cache-Control', 'no-store');
    },
  });

  // Register API routes — normalize to Map
  const executorMap: Map<string, BaseExecutor> = executors instanceof Map
    ? executors
    : executors
      ? new Map([[executors.type, executors]])
      : new Map();
  registerApiRoutes(app, registry, executorMap, scheduler);

  // Fallback: serve index.html for any unmatched route (SPA support)
  app.setNotFoundHandler((_request, reply) => {
    return reply.sendFile('index.html');
  });

  // Retry listen to handle EADDRINUSE from slow process cleanup
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await app.listen({ port, host: '::' });
      break;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE' && attempt < 4) {
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      throw err;
    }
  }

  return app;
}
