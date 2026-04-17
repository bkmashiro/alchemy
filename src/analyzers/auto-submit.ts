// src/analyzers/auto-submit.ts

import { BaseAnalyzer } from './base.js';
import {
  JobRecord,
  AnalysisResult,
  AutoSubmitAnalyzerConfig,
  JobSpec,
  JobStatus,
  ChainStrategyType,
} from '../core/types.js';
import { createLogger } from '../core/logger.js';

const logger = createLogger('AutoSubmitAnalyzer');

/**
 * Interface for submitting follow-up jobs.
 * Fulfilled by the Orchestrator (Agent A).
 */
export interface JobSubmitter {
  submitJob(spec: JobSpec): Promise<string>;
}

/**
 * AutoSubmitAnalyzer — reads chain spec context and decides if follow-up jobs
 * should be submitted.
 *
 * This analyzer runs AFTER MetricsExtractor in the chain.
 * It sets `shouldContinueChain` based on the job's status and extracted metrics.
 * The actual submission of next chain steps is handled by the Orchestrator
 * via the strategy pattern (see src/strategies/).
 *
 * If `followUpJobs` are set on the result (e.g., by a sweep strategy),
 * and a `submitter` is provided, those jobs are submitted here.
 */
export class AutoSubmitAnalyzer extends BaseAnalyzer {
  readonly type = 'auto_submit';
  readonly priority = 50; // runs after MetricsExtractor

  private config: AutoSubmitAnalyzerConfig;
  private submitter?: JobSubmitter;

  constructor(config: AutoSubmitAnalyzerConfig, submitter?: JobSubmitter) {
    super();
    this.config = config;
    this.submitter = submitter;
  }

  /**
   * Attach a job submitter (called by Orchestrator during initialization).
   */
  setSubmitter(submitter: JobSubmitter): void {
    this.submitter = submitter;
  }

  async analyze(
    job: JobRecord,
    logContent: string,
    currentResult: AnalysisResult,
  ): Promise<AnalysisResult> {
    if (this.config.enabled === false) {
      logger.debug({ jobId: job.id }, 'AutoSubmitAnalyzer disabled, skipping');
      return currentResult;
    }

    const isCompleted = job.status === JobStatus.COMPLETED;
    const hasFailed = job.status === JobStatus.FAILED || job.status === JobStatus.TIMEOUT;

    // Determine if the chain should continue
    let shouldContinueChain = isCompleted;

    // If job failed, chain should not continue by default
    if (hasFailed) {
      shouldContinueChain = false;
      logger.info({ jobId: job.id, status: job.status }, 'Job failed — chain will not continue');
    }

    // Build summary
    const metricCount = Object.keys(currentResult.metrics).length;
    const summaryParts: string[] = [];

    if (isCompleted) {
      summaryParts.push(`Job completed successfully with exit code ${job.exitCode ?? 0}`);
    } else if (hasFailed) {
      summaryParts.push(`Job failed with exit code ${job.exitCode ?? -1}`);
    }

    if (metricCount > 0) {
      summaryParts.push(
        `Key metrics: ${Object.entries(currentResult.metrics)
          .slice(0, 5)
          .map(([k, v]) => `${k}=${typeof v === 'number' ? v.toFixed(4) : v}`)
          .join(', ')}`
      );
    }

    // Submit any explicitly queued follow-up jobs (e.g., from sweep expansion)
    if (
      shouldContinueChain &&
      currentResult.followUpJobs &&
      currentResult.followUpJobs.length > 0 &&
      this.submitter
    ) {
      logger.info(
        { jobId: job.id, followUpCount: currentResult.followUpJobs.length },
        'Submitting follow-up jobs'
      );

      const submittedIds: string[] = [];
      for (const followUpSpec of currentResult.followUpJobs) {
        try {
          const newJobId = await this.submitter.submitJob(followUpSpec);
          submittedIds.push(newJobId);
          logger.info({ jobId: job.id, newJobId, jobName: followUpSpec.name }, 'Follow-up job submitted');
        } catch (err) {
          logger.error({ jobId: job.id, jobName: followUpSpec.name, err }, 'Failed to submit follow-up job');
        }
      }

      if (submittedIds.length > 0) {
        summaryParts.push(`Submitted ${submittedIds.length} follow-up job(s): ${submittedIds.map(id => id.slice(0, 8)).join(', ')}`);
      }
    }

    const summary = summaryParts.join('. ');

    return {
      ...currentResult,
      shouldContinueChain,
      summary: currentResult.summary
        ? `${currentResult.summary}\n${summary}`
        : summary,
    };
  }
}
