// src/notifiers/base.ts
// NOTE: This file is owned by Agent B. This is a stub for compilation purposes.

import { JobRecord, ChainRecord } from '../core/types.js';

/**
 * Abstract base class for all notifiers.
 */
export abstract class BaseNotifier {
  /** The notifier type identifier */
  abstract readonly type: string;

  abstract initialize(): Promise<void>;
  abstract notifyJobStarted(job: JobRecord): Promise<void>;
  abstract notifyJobCompleted(job: JobRecord): Promise<void>;
  abstract notifyJobFailed(job: JobRecord, logTail?: string): Promise<void>;
  abstract notifyChainCompleted(chain: ChainRecord): Promise<void>;
  abstract notifyChainFailed(chain: ChainRecord, failedJob: JobRecord): Promise<void>;
  abstract destroy(): Promise<void>;
}
