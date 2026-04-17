// src/core/orchestrator.ts
// Orchestrator — full implementation is Agent A's responsibility.
// Stub provided for webhook handler compilation.

import type { AlchemyConfig, JobSpec, ChainSpec, AlchemyJobId, AlchemyChainId, WebhookPayload } from './types.js';

export class Orchestrator {
  constructor(_config: AlchemyConfig) {}

  async initialize(): Promise<void> {
    throw new Error('Orchestrator.initialize: not implemented (Agent A)');
  }

  async submitJob(_spec: JobSpec): Promise<AlchemyJobId> {
    throw new Error('Orchestrator.submitJob: not implemented (Agent A)');
  }

  async submitChain(_spec: ChainSpec): Promise<AlchemyChainId> {
    throw new Error('Orchestrator.submitChain: not implemented (Agent A)');
  }

  async handleWebhookEvent(_payload: WebhookPayload): Promise<void> {
    throw new Error('Orchestrator.handleWebhookEvent: not implemented (Agent A)');
  }

  async destroy(): Promise<void> {
    // noop
  }
}
