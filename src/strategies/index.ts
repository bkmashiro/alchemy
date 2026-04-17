// src/strategies/index.ts
// Re-exports and self-registration of all chain strategies.

export { BaseChainStrategy } from './base.js';
export type { NextSteps } from './base.js';
export { SequentialStrategy } from './sequential.js';
export { ParallelStrategy } from './parallel.js';
export { ConditionalStrategy } from './conditional.js';
export { HyperparamSweepStrategy } from './sweep.js';
export { evaluateCondition, tokenize } from './conditional.js';
export type { EvalContext, Token } from './conditional.js';

// Self-registration: importing this module registers all strategies in the PluginManager.
import { PluginManager } from '../core/plugin-manager.js';
import { SequentialStrategy } from './sequential.js';
import { ParallelStrategy } from './parallel.js';
import { ConditionalStrategy } from './conditional.js';
import { HyperparamSweepStrategy } from './sweep.js';

PluginManager.instance.registerStrategy(
  'sequential',
  () => new SequentialStrategy(),
);

PluginManager.instance.registerStrategy(
  'parallel',
  () => new ParallelStrategy(),
);

PluginManager.instance.registerStrategy(
  'conditional',
  () => new ConditionalStrategy(),
);

PluginManager.instance.registerStrategy(
  'sweep',
  () => new HyperparamSweepStrategy(),
);
