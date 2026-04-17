// src/strategies/base.ts

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
 *
 * A ChainStrategy decides, given the current state of all jobs in a chain,
 * which steps should be submitted next. It does NOT submit jobs itself —
 * it returns NextSteps and the Orchestrator does the rest.
 */
export abstract class BaseChainStrategy {
  /** Strategy type identifier (matches ChainStrategyType enum) */
  abstract readonly type: string;

  /**
   * Given the chain spec and the current state of all jobs,
   * determine which steps should run next.
   *
   * @param chain - The chain specification
   * @param jobsByStepId - Map from stepId → JobRecord (for completed/running jobs)
   * @param analysisResults - Map from stepId → AnalysisResult (for completed jobs that were analyzed)
   * @returns Which steps are ready, and whether the chain is done
   */
  abstract getNextSteps(
    chain: ChainSpec,
    jobsByStepId: Map<string, JobRecord>,
    analysisResults: Map<string, AnalysisResult>,
  ): NextSteps;
}
