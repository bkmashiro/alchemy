// src/strategies/sweep.ts

import { BaseChainStrategy, NextSteps } from './base.js';
import {
  ChainSpec,
  ChainStepSpec,
  JobRecord,
  AnalysisResult,
  JobStatus,
  JobSpec,
} from '../core/types.js';
import { createLogger } from '../core/logger.js';

const logger = createLogger('HyperparamSweepStrategy');

/**
 * One combination of hyperparameter values.
 */
type ParamCombo = Record<string, string | number>;

/**
 * Generate the Cartesian product of all parameter arrays.
 *
 * @example
 * cartesianProduct({ lr: [0.001, 0.0001], bs: [32, 64] })
 * // → [{lr: 0.001, bs: 32}, {lr: 0.001, bs: 64}, {lr: 0.0001, bs: 32}, {lr: 0.0001, bs: 64}]
 */
function cartesianProduct(grid: Record<string, (string | number)[]>): ParamCombo[] {
  const keys = Object.keys(grid);
  if (keys.length === 0) return [{}];

  const firstKey = keys[0]!;
  const restKeys = keys.slice(1);

  const restGrid: Record<string, (string | number)[]> = {};
  for (const k of restKeys) {
    restGrid[k] = grid[k]!;
  }

  const restCombos = cartesianProduct(restGrid);
  const result: ParamCombo[] = [];

  for (const value of grid[firstKey]!) {
    for (const restCombo of restCombos) {
      result.push({ [firstKey]: value, ...restCombo });
    }
  }

  return result;
}

/**
 * Substitute {{param}} placeholders in a template string.
 */
function interpolate(template: string, params: ParamCombo): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const val = params[key];
    return val !== undefined ? String(val) : `{{${key}}}`;
  });
}

/**
 * HyperparamSweepStrategy — expands a parameter grid into multiple parallel jobs.
 *
 * Input (from ChainSpec.sweepGrid + sweepBaseJob):
 * ```yaml
 * strategy: sweep
 * sweepGrid:
 *   lr: [1e-4, 5e-5, 1e-5]
 *   batch_size: [32, 64]
 * sweepBaseJob:
 *   name: "sweep_lr{{lr}}_bs{{batch_size}}"
 *   command: "python train.py --lr {{lr}} --batch-size {{batch_size}}"
 *   resources: ...
 * ```
 *
 * Expands to 6 parallel jobs with all combinations.
 * Respects `maxConcurrent` to limit concurrent submissions.
 *
 * If `steps` are provided (instead of sweepGrid/sweepBaseJob), falls back to
 * parallel execution of the explicitly defined steps.
 */
export class HyperparamSweepStrategy extends BaseChainStrategy {
  readonly type = 'sweep';

  /** Cache the expanded steps to avoid recalculating each call */
  private expandedStepsCache: Map<string, ChainStepSpec[]> = new Map();

  /**
   * Expand the sweep grid into a list of ChainStepSpecs.
   * Each combination becomes a separate job.
   */
  private expandSweep(chain: ChainSpec): ChainStepSpec[] {
    const cacheKey = chain.name;
    const cached = this.expandedStepsCache.get(cacheKey);
    if (cached) return cached;

    // If explicit steps are provided, use them as-is
    if (chain.steps && chain.steps.length > 0 && !chain.sweepGrid) {
      this.expandedStepsCache.set(cacheKey, chain.steps);
      return chain.steps;
    }

    const grid = chain.sweepGrid;
    const baseJob = chain.sweepBaseJob;

    if (!grid || !baseJob) {
      logger.warn({ chainName: chain.name }, 'HyperparamSweepStrategy: no sweepGrid or sweepBaseJob provided, using explicit steps');
      const fallback = chain.steps ?? [];
      this.expandedStepsCache.set(cacheKey, fallback);
      return fallback;
    }

    const combos = cartesianProduct(grid);
    logger.info({ chainName: chain.name, combos: combos.length }, 'Expanding sweep grid');

    const expandedSteps: ChainStepSpec[] = combos.map((params, idx) => {
      // Interpolate all string fields in the base job
      const expandedJob: JobSpec = {
        ...baseJob,
        name: interpolate(baseJob.name, params),
        command: interpolate(baseJob.command, params),
        // Merge params into metadata for traceability
        metadata: {
          ...baseJob.metadata,
          sweepParams: params,
          sweepIndex: idx,
        },
      };

      const stepId = `sweep_${idx}_${Object.entries(params)
        .map(([k, v]) => `${k}_${v}`)
        .join('_')
        .replace(/[^a-zA-Z0-9_]/g, '_')
        .slice(0, 60)}`;

      return {
        stepId,
        job: expandedJob,
      };
    });

    this.expandedStepsCache.set(cacheKey, expandedSteps);
    return expandedSteps;
  }

  getNextSteps(
    chain: ChainSpec,
    jobsByStepId: Map<string, JobRecord>,
    _analysisResults: Map<string, AnalysisResult>,
  ): NextSteps {
    const failFast = chain.failFast ?? false;
    const maxConcurrent = chain.maxConcurrent ?? Infinity;

    // Get all steps (expanded from sweep grid)
    const allSteps = this.expandSweep(chain);

    if (allSteps.length === 0) {
      return { ready: [], isChainComplete: true, isChainFailed: false };
    }

    const notSubmitted: ChainStepSpec[] = [];
    let runningCount = 0;
    let completedCount = 0;
    let failedCount = 0;

    for (const step of allSteps) {
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

    // Chain is complete when all steps are done (completed or failed without failFast)
    const allDone = runningCount === 0 && notSubmitted.length === 0;
    if (allDone) {
      return {
        ready: [],
        isChainComplete: true,
        isChainFailed: failedCount > 0 && failFast,
        failureReason: failedCount > 0 ? `${failedCount} sweep job(s) failed` : undefined,
      };
    }

    // Calculate available slots
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
