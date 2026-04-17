// src/core/event-bus.ts

import { JobEvent, JobEventType } from './types.js';
import { createLogger } from './logger.js';

type EventHandler = (event: JobEvent) => void | Promise<void>;

const logger = createLogger('EventBus');

/**
 * Typed event bus for job lifecycle events.
 * All notifiers and analyzers subscribe to events through this bus.
 *
 * Usage:
 *   eventBus.on(JobEventType.COMPLETED, async (event) => { ... });
 *   eventBus.emit({ jobId, type: JobEventType.COMPLETED, ... });
 */
export class EventBus {
  private handlers: Map<JobEventType, EventHandler[]>;
  private wildcardHandlers: EventHandler[];

  constructor() {
    this.handlers = new Map();
    this.wildcardHandlers = [];
  }

  /**
   * Subscribe to a specific event type.
   * Returns an unsubscribe function.
   */
  on(type: JobEventType, handler: EventHandler): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, []);
    }
    this.handlers.get(type)!.push(handler);
    return () => {
      const list = this.handlers.get(type);
      if (list) {
        const idx = list.indexOf(handler);
        if (idx !== -1) list.splice(idx, 1);
      }
    };
  }

  /**
   * Subscribe to ALL events (wildcard).
   * Returns an unsubscribe function.
   */
  onAny(handler: EventHandler): () => void {
    this.wildcardHandlers.push(handler);
    return () => {
      const idx = this.wildcardHandlers.indexOf(handler);
      if (idx !== -1) this.wildcardHandlers.splice(idx, 1);
    };
  }

  /**
   * Emit an event. Calls all matching handlers sequentially.
   * Errors in handlers are caught and logged, never propagated.
   */
  async emit(event: JobEvent): Promise<void> {
    const specific = this.handlers.get(event.type) ?? [];
    const all = [...specific, ...this.wildcardHandlers];
    for (const handler of all) {
      try {
        await handler(event);
      } catch (err) {
        logger.error({ err, eventType: event.type, jobId: event.jobId }, 'Event handler error');
      }
    }
  }

  /** Remove all handlers (for cleanup/testing) */
  clear(): void {
    this.handlers.clear();
    this.wildcardHandlers = [];
  }
}
