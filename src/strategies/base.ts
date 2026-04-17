// src/strategies/base.ts
// Abstract base class for chain strategies — owned by Agent B.
// Stub provided here for compilation.

import type {
  ChainSpec,
  ChainStepSpec,
  JobRecord,
  AlchemyJobId,
  AnalysisResult,
} from '../core/types.js';

export interface NextSteps {
  ready: ChainStepSpec[];
  isChainComplete: boolean;
  isChainFailed: boolean;
  failureReason?: string;
}

export abstract class BaseChainStrategy {
  abstract readonly type: string;
  abstract getNextSteps(
    chain: ChainSpec,
    jobsByStepId: Map<string, JobRecord>,
    analysisResults: Map<string, AnalysisResult>,
  ): NextSteps;
}

void (0 as unknown as AlchemyJobId);
