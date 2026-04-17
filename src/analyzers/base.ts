// src/analyzers/base.ts
// Abstract base class for analyzers — owned by Agent B.
// Stub provided here for compilation.

import type { JobRecord, AnalysisResult } from '../core/types.js';

export abstract class BaseAnalyzer {
  abstract readonly type: string;
  abstract readonly priority: number;
  abstract analyze(
    job: JobRecord,
    logContent: string,
    currentResult: AnalysisResult,
  ): Promise<AnalysisResult>;
}
