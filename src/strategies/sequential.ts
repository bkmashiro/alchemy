// src/strategies/sequential.ts

import { BaseChainStrategy, NextSteps } from './base.js';
import {
  ChainSpec,
  ChainStepSpec,
  JobRecord,
  AnalysisResult,
  JobStatus,
} from '../core/types.js';

/**
 * SequentialStrategy — runs jobs one after another.
 *
 * Behavior:
 * - Step N+1 starts only after step N is COMPLETED.
 * - If any step fails and failFast is true (default), the chain stops.
 * - If failFast is false, the next step is still attempted even after failure.
 */
export class SequentialStrategy extends BaseChainStrategy {
  readonly type = 'sequential';

  getNextSteps(
    chain: ChainSpec,
    jobsByStepId: Map<string, JobRecord>,
    _analysisResults: Map<string, AnalysisResult>,
  ): NextSteps {
    const steps = chain.steps;
    const failFast = chain.failFast ?? true;

    if (steps.length === 0) {
      return { ready: [], isChainComplete: true, isChainFailed: false };
    }

    // Find the current position in the sequence
    // A step is "submitted" if it appears in jobsByStepId
    let lastCompletedIndex = -1;
    let hasFailed = false;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      const job = jobsByStepId.get(step.stepId);

      if (!job) {
        // This step hasn't been submitted yet
        break;
      }

      if (job.status === JobStatus.COMPLETED) {
        lastCompletedIndex = i;
      } else if (
        job.status === JobStatus.FAILED ||
        job.status === JobStatus.TIMEOUT ||
        job.status === JobStatus.CANCELLED
      ) {
        hasFailed = true;
        if (failFast) {
          return {
            ready: [],
            isChainComplete: false,
            isChainFailed: true,
            failureReason: `Step "${step.stepId}" failed with status ${job.status}`,
          };
        }
        // If not failFast, treat as if completed for advancement purposes
        lastCompletedIndex = i;
      } else if (
        job.status === JobStatus.RUNNING ||
        job.status === JobStatus.SUBMITTED ||
        job.status === JobStatus.PENDING
      ) {
        // Still running — nothing to do yet
        return { ready: [], isChainComplete: false, isChainFailed: false };
      }
    }

    // Determine the next step to submit
    const nextIndex = lastCompletedIndex + 1;

    if (nextIndex >= steps.length) {
      // All steps have been processed
      return {
        ready: [],
        isChainComplete: true,
        isChainFailed: hasFailed,
      };
    }

    // Check if the next step has already been submitted
    const nextStep = steps[nextIndex]!;
    if (jobsByStepId.has(nextStep.stepId)) {
      // Already submitted, waiting
      return { ready: [], isChainComplete: false, isChainFailed: false };
    }

    return {
      ready: [nextStep],
      isChainComplete: false,
      isChainFailed: false,
    };
  }
}
