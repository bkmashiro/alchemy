// src/notifiers/base.ts
// Abstract base class for notifiers — owned by Agent B.
// Stub provided here for compilation.

import type { JobRecord, JobEvent, ChainRecord } from '../core/types.js';

export abstract class BaseNotifier {
  abstract readonly type: string;
  abstract initialize(): Promise<void>;
  abstract notifyJobStarted(job: JobRecord): Promise<void>;
  abstract notifyJobCompleted(job: JobRecord): Promise<void>;
  abstract notifyJobFailed(job: JobRecord, logTail?: string): Promise<void>;
  abstract notifyChainCompleted(chain: ChainRecord): Promise<void>;
  abstract notifyChainFailed(chain: ChainRecord, failedJob: JobRecord): Promise<void>;
  abstract destroy(): Promise<void>;
}

void (0 as unknown as JobEvent);
