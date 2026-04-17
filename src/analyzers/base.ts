// src/analyzers/base.ts

import { JobRecord, AnalysisResult } from '../core/types.js';

/**
 * Abstract base class for analyzers (Chain of Responsibility pattern).
 *
 * Analyzers process completed jobs to extract metrics, decide whether
 * to continue chains, and optionally generate follow-up job specs.
 *
 * Multiple analyzers form a chain: each one enriches the AnalysisResult
 * and passes it to the next. The Orchestrator calls analyzeJob() which
 * runs the full chain.
 *
 * Order matters:
 *   1. MetricsExtractor — parses log output for numeric metrics
 *   2. AutoSubmitAnalyzer — uses metrics + conditions to decide next steps
 */
export abstract class BaseAnalyzer {
  /** The analyzer type identifier */
  abstract readonly type: string;

  /** Priority for ordering in the chain (lower = runs first). Default: 100 */
  abstract readonly priority: number;

  /**
   * Analyze a completed job. May mutate and enrich the result.
   *
   * @param job - The completed job record
   * @param logContent - The full (or tail) log content
   * @param currentResult - The analysis result so far (from previous analyzers in chain)
   * @returns Enriched analysis result
   */
  abstract analyze(
    job: JobRecord,
    logContent: string,
    currentResult: AnalysisResult,
  ): Promise<AnalysisResult>;
}
