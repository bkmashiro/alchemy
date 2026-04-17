// src/strategies/parallel.ts

import { BaseChainStrategy, NextSteps } from './base.js';
import {
  ChainSpec,
  ChainStepSpec,
  JobRecord,
  AnalysisResult,
  JobStatus,
} from '../core/types.js';

/**
 * ParallelStrategy — runs all jobs simultaneously.
 *
 * Behavior:
 * - On first call (no jobs submitted yet), returns ALL steps as ready.
 * - Respects `maxConcurrent` limit: submits up to N jobs at a time.
 * - Chain is complete when ALL submitted jobs are COMPLETED (or failed).
 * - If failFast is true, signals chain failure on first failure.
 */
export class ParallelStrategy extends BaseChainStrategy {
  readonly type = 'parallel';

  getNextSteps(
    chain: ChainSpec,
    jobsByStepId: Map<string, JobRecord>,
    _analysisResults: Map<string, AnalysisResult>,
  ): NextSteps {
    const steps = chain.steps;
    const failFast = chain.failFast ?? false;
    const maxConcurrent = chain.maxConcurrent ?? Infinity;

    if (steps.length === 0) {
      return { ready: [], isChainComplete: true, isChainFailed: false };
    }

    // Categorize all steps
    const notSubmitted: ChainStepSpec[] = [];
    let runningCount = 0;
    let completedCount = 0;
    let failedCount = 0;

    for (const step of steps) {
      const job = jobsByStepId.get(step.stepId);
      if (!job) {
        notSubmitted.push(step);
      } else if (
        job.status === JobStatus.RUNNING ||
        job.status === JobStatus.SUBMITTED ||
        job.status === JobStatus.PENDING
      ) {
        runningCount++;
      } else if (job.status === JobStatus.COMPLETED) {
        completedCount++;
      } else {
        // FAILED, TIMEOUT, CANCELLED
        failedCount++;
        if (failFast) {
          return {
            ready: [],
            isChainComplete: false,
            isChainFailed: true,
            failureReason: `Step "${step.stepId}" failed with status ${job.status}`,
          };
        }
      }
    }

    // Check if chain is complete
    const totalSubmitted = steps.length - notSubmitted.length;
    const allDone = runningCount === 0 && notSubmitted.length === 0;

    if (allDone) {
      return {
        ready: [],
        isChainComplete: true,
        isChainFailed: failedCount > 0,
        failureReason: failedCount > 0
          ? `${failedCount} step(s) failed`
          : undefined,
      };
    }

    // Submit steps up to maxConcurrent limit
    const availableSlots = maxConcurrent === Infinity
      ? notSubmitted.length
      : Math.max(0, maxConcurrent - runningCount);

    const ready = notSubmitted.slice(0, availableSlots);

    return {
      ready,
      isChainComplete: false,
      isChainFailed: false,
    };
  }
}
