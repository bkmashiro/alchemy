// src/core/scheduler.ts
// Task pool + priority scheduler + SLURM quota awareness.

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { JobRegistry } from './registry.js';
import { PluginManager } from './plugin-manager.js';
import { JobStatus, type JobSpec, type AlchemyJobId, type ISOTimestamp } from './types.js';
import type { BaseExecutor } from '../executors/base.js';
import { createLogger } from './logger.js';

const SLURM_MAX_CONCURRENT = 3;

interface RawPoolRow {
  id: string;
  job_id: string;
  spec: string;
  priority: number;
  executor_type: string;
  added_at: string;
}

const POOL_SCHEMA = `
CREATE TABLE IF NOT EXISTS pool (
  id            TEXT PRIMARY KEY,
  job_id        TEXT NOT NULL,
  spec          TEXT NOT NULL,
  priority      INTEGER NOT NULL DEFAULT 50,
  executor_type TEXT NOT NULL,
  added_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pool_priority ON pool(priority DESC, added_at ASC);
`;

export interface PoolEntry {
  id: string;
  jobId: AlchemyJobId;
  spec: JobSpec;
  priority: number;
  executorType: string;
  addedAt: ISOTimestamp;
}

export class Scheduler {
  private db: Database.Database;
  private registry: JobRegistry;
  private executors: Map<string, BaseExecutor>;
  private logger = createLogger('Scheduler');

  constructor(dbPath: string, registry: JobRegistry, executors: Map<string, BaseExecutor>) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(POOL_SCHEMA);
    this.registry = registry;
    this.executors = executors;
  }

  // ─── Pool Management ──────────────────────────────────────

  addToPool(spec: JobSpec, executorType: string, priority?: number): PoolEntry {
    const id = randomUUID();
    const jobId = this.registry.createJob(spec, executorType);
    const now = new Date().toISOString();
    const pri = priority ?? spec.priority ?? 50;

    this.db.prepare(
      'INSERT INTO pool (id, job_id, spec, priority, executor_type, added_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, jobId, JSON.stringify(spec), pri, executorType, now);

    this.logger.info({ id, jobId, priority: pri, executorType }, 'Job added to pool');
    return { id, jobId, spec, priority: pri, executorType, addedAt: now };
  }

  listPool(): PoolEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM pool ORDER BY priority DESC, added_at ASC')
      .all() as RawPoolRow[];
    return rows.map(this._rowToEntry);
  }

  setPriority(poolId: string, priority: number): void {
    const result = this.db
      .prepare('UPDATE pool SET priority = ? WHERE id = ?')
      .run(priority, poolId);
    if (result.changes === 0) {
      throw new Error(`Pool entry not found: ${poolId}`);
    }
  }

  removeFromPool(poolId: string): void {
    this.db.prepare('DELETE FROM pool WHERE id = ?').run(poolId);
  }

  private _rowToEntry(row: RawPoolRow): PoolEntry {
    return {
      id: row.id,
      jobId: row.job_id,
      spec: JSON.parse(row.spec) as JobSpec,
      priority: row.priority,
      executorType: row.executor_type,
      addedAt: row.added_at,
    };
  }

  // ─── SLURM Quota Check ────────────────────────────────────

  /**
   * Count currently running/pending SLURM jobs for the configured user.
   * Runs `squeue -u <user>` on the SLURM executor.
   */
  async getSlurmJobCount(user: string): Promise<number> {
    const executor = this.executors.get('slurm_ssh');
    if (!executor) return 0;

    try {
      // Use the executor's private execRemote via a type cast
      // SlurmSSHExecutor exposes no public execRemote, so we query the registry instead
      const { jobs } = this.registry.listJobs({
        status: [JobStatus.RUNNING, JobStatus.SUBMITTED],
        limit: 1000,
      });
      return jobs.filter(j => j.executorType === 'slurm_ssh').length;
    } catch {
      return 0;
    }
  }

  atSlurmQuota(count: number): boolean {
    return count >= SLURM_MAX_CONCURRENT;
  }

  // ─── Dispatch Loop ────────────────────────────────────────

  /**
   * Try to dispatch pending pool jobs. Call this after a job completes/fails.
   * Respects SLURM quota and workstation availability.
   */
  async tryDispatch(): Promise<void> {
    const pending = this.listPool();
    if (pending.length === 0) return;

    const slurmCount = await this.getSlurmJobCount('ys25');

    for (const entry of pending) {
      const executor = this.executors.get(entry.executorType);
      if (!executor) {
        this.logger.warn({ executorType: entry.executorType }, 'No executor for pool entry, skipping');
        continue;
      }

      if (entry.executorType === 'slurm_ssh' && this.atSlurmQuota(slurmCount)) {
        this.logger.info({ slurmCount, max: SLURM_MAX_CONCURRENT }, 'SLURM at quota, stopping dispatch');
        break;
      }

      try {
        const result = await executor.submit(entry.jobId, entry.spec);
        this.registry.updateJob(entry.jobId, {
          slurmJobId: result.externalJobId,
          status: JobStatus.SUBMITTED,
          logPath: result.logPath,
        });
        this.removeFromPool(entry.id);
        this.logger.info({ poolId: entry.id, jobId: entry.jobId, externalId: result.externalJobId }, 'Dispatched pool job');
      } catch (err) {
        this.logger.error({ err, poolId: entry.id }, 'Failed to dispatch pool job');
        // Leave in pool for retry
        break;
      }
    }
  }

  close(): void {
    this.db.close();
  }
}

// ─── SLURM Queue Probe ────────────────────────────────────────

/**
 * Parse `squeue -u <user>` output to count running+pending jobs.
 * Input: raw stdout from squeue with default format.
 */
export function parseSqueueCount(stdout: string): number {
  const lines = stdout.trim().split('\n').filter(l => l.trim().length > 0);
  // First line is header
  return Math.max(0, lines.length - 1);
}

/**
 * Create a Scheduler that shares the same DB file as the registry.
 * Uses a separate table so the same path works fine.
 */
export function createScheduler(
  dbPath: string,
  registry: JobRegistry,
  executors: Map<string, BaseExecutor>,
): Scheduler {
  return new Scheduler(dbPath, registry, executors);
}
