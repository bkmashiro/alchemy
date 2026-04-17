// src/core/registry.ts
// Stub implementation — full implementation is Agent A's responsibility.
// This stub provides type-compatible interfaces for Agent C's dashboard/CLI code.

import {
  AlchemyJobId,
  AlchemyChainId,
  JobRecord,
  JobEvent,
  ChainRecord,
  ChainSpec,
  JobSpec,
  JobStatus,
  ChainStatus,
  MetricsMap,
} from './types.js';
import { JobNotFoundError, ChainNotFoundError } from './errors.js';

export class JobRegistry {
  private db: unknown;

  constructor(_dbPath: string) {
    // Stub: Agent A implements the full SQLite-backed version
    this.db = null;
  }

  createJob(
    _spec: JobSpec,
    _executorType: string,
    _chainId?: AlchemyChainId,
    _chainIndex?: number,
    _stepId?: string,
  ): AlchemyJobId {
    throw new Error('JobRegistry.createJob: not implemented (Agent A)');
  }

  getJob(_id: AlchemyJobId): JobRecord {
    throw new JobNotFoundError(_id);
  }

  getJobBySlurmId(_slurmJobId: string): JobRecord | null {
    return null;
  }

  updateJob(
    _id: AlchemyJobId,
    _update: Partial<
      Pick<JobRecord, 'slurmJobId' | 'status' | 'exitCode' | 'node' | 'elapsed' | 'logPath' | 'metrics'>
    >,
  ): void {
    throw new Error('JobRegistry.updateJob: not implemented (Agent A)');
  }

  listJobs(opts?: {
    status?: JobStatus | JobStatus[];
    chainId?: AlchemyChainId;
    tags?: string[];
    limit?: number;
    offset?: number;
  }): { jobs: JobRecord[]; total: number } {
    void opts;
    return { jobs: [], total: 0 };
  }

  addEvent(_event: Omit<JobEvent, 'id'>): void {
    throw new Error('JobRegistry.addEvent: not implemented (Agent A)');
  }

  getEvents(_jobId: AlchemyJobId): JobEvent[] {
    return [];
  }

  createChain(_spec: ChainSpec): AlchemyChainId {
    throw new Error('JobRegistry.createChain: not implemented (Agent A)');
  }

  getChain(_id: AlchemyChainId): ChainRecord {
    throw new ChainNotFoundError(_id);
  }

  updateChain(
    _id: AlchemyChainId,
    _update: Partial<Pick<ChainRecord, 'status'>>,
  ): void {
    throw new Error('JobRegistry.updateChain: not implemented (Agent A)');
  }

  linkJobToChain(
    _chainId: AlchemyChainId,
    _jobId: AlchemyJobId,
    _stepId: string,
    _position: number,
  ): void {
    throw new Error('JobRegistry.linkJobToChain: not implemented (Agent A)');
  }

  getChainJobs(_chainId: AlchemyChainId): JobRecord[] {
    return [];
  }

  getChainJobsByStepId(_chainId: AlchemyChainId): Map<string, JobRecord> {
    return new Map();
  }

  listChains(opts?: {
    status?: ChainStatus | ChainStatus[];
    limit?: number;
    offset?: number;
  }): { chains: ChainRecord[]; total: number } {
    void opts;
    return { chains: [], total: 0 };
  }

  setMetrics(_jobId: AlchemyJobId, _metrics: MetricsMap): void {
    throw new Error('JobRegistry.setMetrics: not implemented (Agent A)');
  }

  getMetrics(_jobId: AlchemyJobId): MetricsMap {
    return {};
  }

  close(): void {
    // noop in stub
  }
}
