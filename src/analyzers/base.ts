// src/analyzers/base.ts
// NOTE: This file is owned by Agent B. This is a stub for compilation purposes.

import { JobRecord, AnalysisResult } from '../core/types.js';

/**
 * Abstract base class for analyzers (Chain of Responsibility pattern).
 */
export abstract class BaseAnalyzer {
  /** The analyzer type identifier */
  abstract readonly type: string;

  /** Priority for ordering in the chain (lower = runs first). Default: 100 */
  abstract readonly priority: number;

  abstract analyze(
    job: JobRecord,
    logContent: string,
    currentResult: AnalysisResult,
  ): Promise<AnalysisResult>;
}
