// src/executors/base.ts

import {
  JobSpec,
  JobStatus,
  AlchemyJobId,
  SlurmJobId,
} from '../core/types.js';

/**
 * Result of a job submission.
 */
export interface SubmitResult {
  /** Executor-specific job ID (Slurm job ID for SlurmSSH) */
  externalJobId: SlurmJobId;
  /** Absolute path to the log file on the remote system */
  logPath: string;
}

/**
 * Result of a status query for a single job.
 */
export interface StatusResult {
  status: JobStatus;
  /** Compute node name, if available */
  node?: string;
  /** Exit code, if job is finished */
  exitCode?: number;
  /** Elapsed wall-clock seconds, if available */
  elapsed?: number;
}

/**
 * Abstract base class for all executors.
 */
export abstract class BaseExecutor {
  /** The executor type identifier (e.g., 'slurm_ssh', 'local') */
  abstract readonly type: string;

  /**
   * Initialize the executor (e.g., establish SSH connection).
   */
  abstract initialize(): Promise<void>;

  /**
   * Submit a job to the execution backend.
   */
  abstract submit(alchemyJobId: AlchemyJobId, spec: JobSpec): Promise<SubmitResult>;

  /**
   * Query the current status of a job.
   */
  abstract status(externalJobId: SlurmJobId): Promise<StatusResult>;

  /**
   * Cancel a running or pending job.
   */
  abstract cancel(externalJobId: SlurmJobId): Promise<void>;

  /**
   * Fetch the last N lines of a job's log output.
   */
  abstract fetchLogs(logPath: string, tailLines?: number): Promise<string>;

  /**
   * Tear down the executor (e.g., close SSH connection).
   */
  abstract destroy(): Promise<void>;
}
