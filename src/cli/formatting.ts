// src/cli/formatting.ts

import chalk from 'chalk';
import Table from 'cli-table3';
import { JobStatus, ChainStatus, JobRecord, ChainRecord } from '../core/types.js';

/**
 * Color-code a job status string.
 */
export function colorStatus(status: JobStatus | ChainStatus): string {
  switch (status) {
    case JobStatus.PENDING:
    case ChainStatus.PENDING:
      return chalk.yellow(status);
    case JobStatus.SUBMITTED:
      return chalk.cyan(status);
    case JobStatus.RUNNING:
    case ChainStatus.RUNNING:
      return chalk.blue.bold(status);
    case JobStatus.COMPLETED:
    case ChainStatus.COMPLETED:
      return chalk.green(status);
    case JobStatus.FAILED:
    case ChainStatus.FAILED:
      return chalk.red.bold(status);
    case JobStatus.CANCELLED:
    case ChainStatus.CANCELLED:
      return chalk.gray(status);
    case JobStatus.TIMEOUT:
      return chalk.red(status);
    case ChainStatus.PARTIAL:
      return chalk.yellow(status);
    default:
      return chalk.gray.italic(status);
  }
}

/**
 * Shorten a UUID for display (first 8 chars).
 */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

/**
 * Format elapsed seconds as human-readable string.
 */
export function formatElapsed(seconds: number | null): string {
  if (seconds === null || seconds === undefined) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/**
 * Create a formatted table of jobs.
 */
export function formatJobTable(jobs: JobRecord[]): string {
  const table = new Table({
    head: ['ID', 'Slurm ID', 'Name', 'Status', 'Partition', 'Node', 'Elapsed', 'Created'],
    style: { head: ['cyan'] },
  });

  for (const job of jobs) {
    table.push([
      shortId(job.id),
      job.slurmJobId ?? '—',
      job.spec.name,
      colorStatus(job.status),
      job.spec.resources.partition,
      job.node ?? '—',
      formatElapsed(job.elapsed),
      new Date(job.createdAt).toLocaleString(),
    ]);
  }

  return table.toString();
}

/**
 * Create a formatted table of chains.
 */
export function formatChainTable(chains: ChainRecord[]): string {
  const table = new Table({
    head: ['Chain ID', 'Name', 'Strategy', 'Status', 'Jobs', 'Created'],
    style: { head: ['cyan'] },
  });

  for (const chain of chains) {
    table.push([
      shortId(chain.id),
      chain.spec.name,
      chain.spec.strategy,
      colorStatus(chain.status),
      chain.jobIds.length.toString(),
      new Date(chain.createdAt).toLocaleString(),
    ]);
  }

  return table.toString();
}

/**
 * Render a progress bar. E.g., "████████░░ 8/10"
 */
export function progressBar(completed: number, total: number, width = 20): string {
  if (total === 0) return `${'░'.repeat(width)} 0/0`;
  const filled = Math.floor((completed / total) * width);
  const empty = width - filled;
  return `${'█'.repeat(filled)}${'░'.repeat(empty)} ${completed}/${total}`;
}
