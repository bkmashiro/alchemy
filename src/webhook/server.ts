// src/webhook/server.ts
// NOTE: Full implementation is owned by Agent B. This is a stub.

import { AlchemyOrchestrator } from '../core/orchestrator.js';

export async function createWebhookServer(
  _orchestrator: AlchemyOrchestrator,
  port: number,
  _secret?: string,
): Promise<void> {
  console.log(`Webhook server stub — port ${port}`);
  console.log('Full implementation pending Agent B.');
}
