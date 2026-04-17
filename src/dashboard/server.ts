// src/dashboard/server.ts
// HTTP server serving static files + REST API for the Alchemy dashboard.

import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerApiRoutes } from './api.js';
import { JobRegistry } from '../core/registry.js';

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
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: 'warn',
    },
  });

  await app.register(fastifyCors, { origin: true });

  // Serve static files from public/ directory
  await app.register(fastifyStatic, {
    root: join(__dirname, 'public'),
    prefix: '/',
  });

  // Register API routes
  registerApiRoutes(app, registry);

  // Fallback: serve index.html for any unmatched route (SPA support)
  app.setNotFoundHandler((_request, reply) => {
    return reply.sendFile('index.html');
  });

  await app.listen({ port, host: '0.0.0.0' });

  return app;
}
