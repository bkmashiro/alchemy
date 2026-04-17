// src/executors/base.ts
// Abstract base class for executors — owned by Agent A.
// Stub provided here for compilation.

import type {
  JobSpec,
  JobRecord,
  JobStatus,
  ExecutorConfig,
  AlchemyJobId,
  SlurmJobId,
} from '../core/types.js';

export interface SubmitResult {
  externalJobId: SlurmJobId;
  logPath: string;
}

export interface StatusResult {
  status: JobStatus;
  node?: string;
  exitCode?: number;
  elapsed?: number;
}

export abstract class BaseExecutor {
  abstract readonly type: string;
  abstract initialize(): Promise<void>;
  abstract submit(alchemyJobId: AlchemyJobId, spec: JobSpec): Promise<SubmitResult>;
  abstract status(externalJobId: SlurmJobId): Promise<StatusResult>;
  abstract cancel(externalJobId: SlurmJobId): Promise<void>;
  abstract fetchLogs(logPath: string, tailLines?: number): Promise<string>;
  abstract destroy(): Promise<void>;
}

// Suppress unused import warnings from strict mode
void (0 as unknown as JobRecord);
void (0 as unknown as ExecutorConfig);
