// src/notifiers/base.ts

import { JobRecord, ChainRecord } from '../core/types.js';

/**
 * Abstract base class for all notifiers.
 *
 * Notifiers are Observers on the EventBus. They receive job events
 * and send notifications to external systems (Discord, Slack, email, etc.).
 *
 * The Orchestrator subscribes notifiers to the EventBus during initialization.
 */
export abstract class BaseNotifier {
  /** The notifier type identifier */
  abstract readonly type: string;

  /**
   * Initialize the notifier (e.g., validate webhook URL).
   */
  abstract initialize(): Promise<void>;

  /**
   * Called when a job starts running.
   */
  abstract notifyJobStarted(job: JobRecord): Promise<void>;

  /**
   * Called when a job completes successfully.
   */
  abstract notifyJobCompleted(job: JobRecord): Promise<void>;

  /**
   * Called when a job fails.
   * @param logTail - Last ~20 lines of the log for error context
   */
  abstract notifyJobFailed(job: JobRecord, logTail?: string): Promise<void>;

  /**
   * Called when a chain completes (all jobs done).
   */
  abstract notifyChainCompleted(chain: ChainRecord): Promise<void>;

  /**
   * Called when a chain fails (some job in chain failed).
   */
  abstract notifyChainFailed(chain: ChainRecord, failedJob: JobRecord): Promise<void>;

  /**
   * Tear down the notifier.
   */
  abstract destroy(): Promise<void>;
}
