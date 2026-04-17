// src/strategies/base.ts
// NOTE: This file is owned by Agent B. This is a stub for compilation purposes.

import {
  ChainSpec,
  ChainStepSpec,
  JobRecord,
  AnalysisResult,
} from '../core/types.js';

/**
 * Describes which steps are ready to be submitted right now.
 */
export interface NextSteps {
  /** Step specs that should be submitted now */
  ready: ChainStepSpec[];
  /** True if the chain is completely done (no more steps, all finished) */
  isChainComplete: boolean;
  /** True if the chain should be marked as failed */
  isChainFailed: boolean;
  /** Human-readable reason if failed */
  failureReason?: string;
}

/**
 * Abstract base class for chain strategies.
 */
export abstract class BaseChainStrategy {
  /** Strategy type identifier (matches ChainStrategyType enum) */
  abstract readonly type: string;

  abstract getNextSteps(
    chain: ChainSpec,
    jobsByStepId: Map<string, JobRecord>,
    analysisResults: Map<string, AnalysisResult>,
  ): NextSteps;
}
