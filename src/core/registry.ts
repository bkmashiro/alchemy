// src/core/registry.ts

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import {
  JobSpec,
  JobRecord,
  JobStatus,
  JobEvent,
  JobEventType,
  ChainSpec,
  ChainRecord,
  ChainStatus,
  MetricsMap,
  AlchemyJobId,
  AlchemyChainId,
  SlurmJobId,
} from './types.js';
import { JobNotFoundError, ChainNotFoundError } from './errors.js';

const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS jobs (
  id              TEXT PRIMARY KEY,
  slurm_job_id    TEXT,
  spec            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  executor_type   TEXT NOT NULL,
  chain_id        TEXT,
  chain_index     INTEGER,
  step_id         TEXT,
  exit_code       INTEGER,
  node            TEXT,
  elapsed         REAL,
  log_path        TEXT,
  metrics         TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_chain_id ON jobs(chain_id);
CREATE INDEX IF NOT EXISTS idx_jobs_slurm_id ON jobs(slurm_job_id);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at);

CREATE TABLE IF NOT EXISTS events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id          TEXT NOT NULL REFERENCES jobs(id),
  type            TEXT NOT NULL,
  timestamp       TEXT NOT NULL,
  payload         TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_events_job_id ON events(job_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);

CREATE TABLE IF NOT EXISTS chains (
  id              TEXT PRIMARY KEY,
  spec            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chain_jobs (
  chain_id        TEXT NOT NULL REFERENCES chains(id),
  job_id          TEXT NOT NULL REFERENCES jobs(id),
  step_id         TEXT NOT NULL,
  position        INTEGER NOT NULL,
  PRIMARY KEY (chain_id, job_id)
);

CREATE INDEX IF NOT EXISTS idx_chain_jobs_chain ON chain_jobs(chain_id);

CREATE TABLE IF NOT EXISTS metrics (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id          TEXT NOT NULL REFERENCES jobs(id),
  key             TEXT NOT NULL,
  value           REAL NOT NULL,
  timestamp       TEXT NOT NULL,
  UNIQUE(job_id, key)
);

CREATE INDEX IF NOT EXISTS idx_metrics_job ON metrics(job_id);
`;

interface RawJobRow {
  id: string;
  slurm_job_id: string | null;
  spec: string;
  status: string;
  executor_type: string;
  chain_id: string | null;
  chain_index: number | null;
  step_id: string | null;
  exit_code: number | null;
  node: string | null;
  elapsed: number | null;
  log_path: string | null;
  metrics: string | null;
  created_at: string;
  updated_at: string;
}

interface RawEventRow {
  id: number;
  job_id: string;
  type: string;
  timestamp: string;
  payload: string;
}

interface RawChainRow {
  id: string;
  spec: string;
  status: string;
  created_at: string;
  updated_at: string;
}

function rowToJobRecord(row: RawJobRow): JobRecord {
  return {
    id: row.id,
    slurmJobId: row.slurm_job_id,
    spec: JSON.parse(row.spec) as JobSpec,
    status: row.status as JobStatus,
    executorType: row.executor_type,
    chainId: row.chain_id,
    chainIndex: row.chain_index,
    exitCode: row.exit_code,
    node: row.node,
    elapsed: row.elapsed,
    logPath: row.log_path,
    metrics: row.metrics ? (JSON.parse(row.metrics) as MetricsMap) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class JobRegistry {
  private db: Database.Database;

  /**
   * Initialize the registry. Opens/creates the SQLite database at the given path.
   * Runs migrations if needed (checked via PRAGMA user_version).
   */
  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  /** Run schema migrations */
  private migrate(): void {
    const version = (this.db.pragma('user_version', { simple: true }) as number) ?? 0;
    if (version < SCHEMA_VERSION) {
      this.db.exec(SCHEMA_SQL);
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    }
  }

  // ─── Job CRUD ──────────────────────────────────────

  /**
   * Create a new job record in PENDING status. Returns the generated UUID.
   */
  createJob(
    spec: JobSpec,
    executorType: string,
    chainId?: AlchemyChainId,
    chainIndex?: number,
    stepId?: string,
  ): AlchemyJobId {
    const id = randomUUID();
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO jobs (id, slurm_job_id, spec, status, executor_type, chain_id, chain_index, step_id, exit_code, node, elapsed, log_path, metrics, created_at, updated_at)
      VALUES (?, NULL, ?, 'pending', ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)
    `);
    stmt.run(
      id,
      JSON.stringify(spec),
      executorType,
      chainId ?? null,
      chainIndex ?? null,
      stepId ?? null,
      now,
      now,
    );
    return id;
  }

  /**
   * Get a job by its alchemy ID.
   * @throws JobNotFoundError if not found
   */
  getJob(id: AlchemyJobId): JobRecord {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as RawJobRow | undefined;
    if (!row) throw new JobNotFoundError(id);
    return rowToJobRecord(row);
  }

  /**
   * Get a job by its Slurm job ID. Returns null if not found.
   */
  getJobBySlurmId(slurmJobId: SlurmJobId): JobRecord | null {
    const row = this.db
      .prepare('SELECT * FROM jobs WHERE slurm_job_id = ?')
      .get(slurmJobId) as RawJobRow | undefined;
    return row ? rowToJobRecord(row) : null;
  }

  /**
   * Update a job's status and optional fields.
   * Automatically updates updatedAt.
   */
  updateJob(
    id: AlchemyJobId,
    update: Partial<
      Pick<JobRecord, 'slurmJobId' | 'status' | 'exitCode' | 'node' | 'elapsed' | 'logPath' | 'metrics'>
    >,
  ): void {
    const now = new Date().toISOString();
    const sets: string[] = ['updated_at = ?'];
    const values: unknown[] = [now];

    if (update.slurmJobId !== undefined) { sets.push('slurm_job_id = ?'); values.push(update.slurmJobId); }
    if (update.status !== undefined) { sets.push('status = ?'); values.push(update.status); }
    if (update.exitCode !== undefined) { sets.push('exit_code = ?'); values.push(update.exitCode); }
    if (update.node !== undefined) { sets.push('node = ?'); values.push(update.node); }
    if (update.elapsed !== undefined) { sets.push('elapsed = ?'); values.push(update.elapsed); }
    if (update.logPath !== undefined) { sets.push('log_path = ?'); values.push(update.logPath); }
    if (update.metrics !== undefined) { sets.push('metrics = ?'); values.push(JSON.stringify(update.metrics)); }

    values.push(id);
    this.db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  /**
   * List jobs with optional filters.
   */
  listJobs(opts?: {
    status?: JobStatus | JobStatus[];
    chainId?: AlchemyChainId;
    tags?: string[];
    limit?: number;
    offset?: number;
  }): { jobs: JobRecord[]; total: number } {
    const limit = opts?.limit ?? 50;
    const offset = opts?.offset ?? 0;
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts?.status) {
      const statuses = Array.isArray(opts.status) ? opts.status : [opts.status];
      conditions.push(`status IN (${statuses.map(() => '?').join(',')})`);
      params.push(...statuses);
    }

    if (opts?.chainId) {
      conditions.push('chain_id = ?');
      params.push(opts.chainId);
    }

    if (opts?.tags && opts.tags.length > 0) {
      for (const tag of opts.tags) {
        conditions.push(
          `EXISTS (SELECT 1 FROM json_each(json_extract(spec, '$.tags')) WHERE value = ?)`,
        );
        params.push(tag);
      }
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM jobs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as RawJobRow[];

    const totalRow = this.db
      .prepare(`SELECT COUNT(*) as count FROM jobs ${where}`)
      .get(...params) as { count: number };

    return {
      jobs: rows.map(rowToJobRecord),
      total: totalRow.count,
    };
  }

  // ─── Event Operations ──────────────────────────────

  /**
   * Record a job event.
   */
  addEvent(event: Omit<JobEvent, 'id'>): void {
    this.db
      .prepare(
        'INSERT INTO events (job_id, type, timestamp, payload) VALUES (?, ?, ?, ?)',
      )
      .run(event.jobId, event.type, event.timestamp, JSON.stringify(event.payload));
  }

  /**
   * Get all events for a job, ordered by timestamp.
   */
  getEvents(jobId: AlchemyJobId): JobEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE job_id = ? ORDER BY timestamp ASC')
      .all(jobId) as RawEventRow[];
    return rows.map((row) => ({
      id: row.id,
      jobId: row.job_id,
      type: row.type as JobEventType,
      timestamp: row.timestamp,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
    }));
  }

  // ─── Chain CRUD ────────────────────────────────────

  /**
   * Create a new chain record. Returns the chain UUID.
   */
  createChain(spec: ChainSpec): AlchemyChainId {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO chains (id, spec, status, created_at, updated_at) VALUES (?, ?, 'pending', ?, ?)",
      )
      .run(id, JSON.stringify(spec), now, now);
    return id;
  }

  /**
   * Get a chain by ID.
   * @throws ChainNotFoundError if not found
   */
  getChain(id: AlchemyChainId): ChainRecord {
    const row = this.db
      .prepare('SELECT * FROM chains WHERE id = ?')
      .get(id) as RawChainRow | undefined;
    if (!row) throw new ChainNotFoundError(id);

    // Get associated job IDs in order
    const jobRows = this.db
      .prepare('SELECT job_id FROM chain_jobs WHERE chain_id = ? ORDER BY position ASC')
      .all(id) as { job_id: string }[];

    return {
      id: row.id,
      spec: JSON.parse(row.spec) as ChainSpec,
      status: row.status as ChainStatus,
      jobIds: jobRows.map((r) => r.job_id),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Update chain status.
   */
  updateChain(id: AlchemyChainId, update: Partial<Pick<ChainRecord, 'status'>>): void {
    const now = new Date().toISOString();
    if (update.status !== undefined) {
      this.db
        .prepare('UPDATE chains SET status = ?, updated_at = ? WHERE id = ?')
        .run(update.status, now, id);
    }
  }

  /**
   * Link a job to a chain (insert into chain_jobs).
   */
  linkJobToChain(
    chainId: AlchemyChainId,
    jobId: AlchemyJobId,
    stepId: string,
    position: number,
  ): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO chain_jobs (chain_id, job_id, step_id, position) VALUES (?, ?, ?, ?)',
      )
      .run(chainId, jobId, stepId, position);
  }

  /**
   * Get all jobs belonging to a chain, ordered by position.
   */
  getChainJobs(chainId: AlchemyChainId): JobRecord[] {
    const rows = this.db
      .prepare(
        `SELECT j.* FROM jobs j
         JOIN chain_jobs cj ON cj.job_id = j.id
         WHERE cj.chain_id = ?
         ORDER BY cj.position ASC`,
      )
      .all(chainId) as RawJobRow[];
    return rows.map(rowToJobRecord);
  }

  /**
   * Get chain jobs indexed by step ID.
   */
  getChainJobsByStepId(chainId: AlchemyChainId): Map<string, JobRecord> {
    const rows = this.db
      .prepare(
        `SELECT j.*, cj.step_id as cj_step_id FROM jobs j
         JOIN chain_jobs cj ON cj.job_id = j.id
         WHERE cj.chain_id = ?`,
      )
      .all(chainId) as (RawJobRow & { cj_step_id: string })[];

    const map = new Map<string, JobRecord>();
    for (const row of rows) {
      map.set(row.cj_step_id, rowToJobRecord(row));
    }
    return map;
  }

  /**
   * List chains with optional filters.
   */
  listChains(opts?: {
    status?: ChainStatus | ChainStatus[];
    limit?: number;
    offset?: number;
  }): { chains: ChainRecord[]; total: number } {
    const limit = opts?.limit ?? 50;
    const offset = opts?.offset ?? 0;
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts?.status) {
      const statuses = Array.isArray(opts.status) ? opts.status : [opts.status];
      conditions.push(`status IN (${statuses.map(() => '?').join(',')})`);
      params.push(...statuses);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM chains ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as RawChainRow[];

    const totalRow = this.db
      .prepare(`SELECT COUNT(*) as count FROM chains ${where}`)
      .get(...params) as { count: number };

    // Fetch job IDs for each chain
    const chains = rows.map((row) => {
      const jobRows = this.db
        .prepare('SELECT job_id FROM chain_jobs WHERE chain_id = ? ORDER BY position ASC')
        .all(row.id) as { job_id: string }[];
      return {
        id: row.id,
        spec: JSON.parse(row.spec) as ChainSpec,
        status: row.status as ChainStatus,
        jobIds: jobRows.map((r) => r.job_id),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      } satisfies ChainRecord;
    });

    return { chains, total: totalRow.count };
  }

  // ─── Metrics Operations ────────────────────────────

  /**
   * Store extracted metrics for a job (upsert).
   */
  setMetrics(jobId: AlchemyJobId, metrics: MetricsMap): void {
    const now = new Date().toISOString();
    const upsert = this.db.prepare(
      'INSERT INTO metrics (job_id, key, value, timestamp) VALUES (?, ?, ?, ?) ON CONFLICT(job_id, key) DO UPDATE SET value = excluded.value, timestamp = excluded.timestamp',
    );
    const transaction = this.db.transaction((m: MetricsMap) => {
      for (const [key, value] of Object.entries(m)) {
        upsert.run(jobId, key, value, now);
      }
    });
    transaction(metrics);
  }

  /**
   * Get metrics for a job.
   */
  getMetrics(jobId: AlchemyJobId): MetricsMap {
    const rows = this.db
      .prepare('SELECT key, value FROM metrics WHERE job_id = ?')
      .all(jobId) as { key: string; value: number }[];
    const result: MetricsMap = {};
    for (const row of rows) {
      result[row.key] = row.value;
    }
    return result;
  }

  // ─── Cleanup ───────────────────────────────────────

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
  }
}
