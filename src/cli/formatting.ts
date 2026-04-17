// src/cli/formatting.ts
// Table formatting and color helpers for CLI output.

import chalk from 'chalk';
import Table from 'cli-table3';
import { JobStatus, ChainStatus, type JobRecord, type ChainRecord } from '../core/types.js';

// ─── Status Colors ────────────────────────────────────────────

const STATUS_EMOJI: Record<string, string> = {
  [JobStatus.PENDING]: '⏳',
  [JobStatus.SUBMITTED]: '📤',
  [JobStatus.RUNNING]: '🔄',
  [JobStatus.COMPLETED]: '✅',
  [JobStatus.FAILED]: '❌',
  [JobStatus.CANCELLED]: '🚫',
  [JobStatus.TIMEOUT]: '⏰',
  [JobStatus.UNKNOWN]: '❓',
  [ChainStatus.PARTIAL]: '⚠️',
};

/**
 * Color-code a job/chain status string.
 */
export function colorStatus(status: JobStatus | ChainStatus): string {
  const emoji = STATUS_EMOJI[status] ?? '';
  switch (status) {
    case JobStatus.PENDING:
      return chalk.yellow(`${emoji} ${status}`);
    case JobStatus.SUBMITTED:
      return chalk.cyan(`${emoji} ${status}`);
    case JobStatus.RUNNING:
      return chalk.blue.bold(`${emoji} ${status}`);
    case JobStatus.COMPLETED:
      return chalk.green(`${emoji} ${status}`);
    case JobStatus.FAILED:
      return chalk.red.bold(`${emoji} ${status}`);
    case JobStatus.CANCELLED:
      return chalk.gray(`${emoji} ${status}`);
    case JobStatus.TIMEOUT:
      return chalk.red(`${emoji} ${status}`);
    case ChainStatus.PARTIAL:
      return chalk.yellow(`${emoji} ${status}`);
    default:
      return chalk.gray.italic(`${emoji} ${status}`);
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
 * E.g., 3661 → "1h 1m 1s"
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
 * Format a MetricsMap as a compact string.
 * E.g., { loss: 1.87, acc: 0.71 } → "loss=1.87  acc=0.71"
 */
export function formatMetrics(metrics: Record<string, number> | null): string {
  if (!metrics || Object.keys(metrics).length === 0) return '—';
  return Object.entries(metrics)
    .map(([k, v]) => `${k}=${typeof v === 'number' ? v.toFixed(4) : String(v)}`)
    .join('  ');
}

/**
 * Render a progress bar. E.g., "████████░░ 8/10"
 */
export function progressBar(completed: number, total: number, width = 10): string {
  if (total === 0) return `${'░'.repeat(width)} 0/0`;
  const filled = Math.round((completed / total) * width);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  return `${bar} ${completed}/${total}`;
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
      chalk.dim(shortId(job.id)),
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
    head: ['ID', 'Name', 'Strategy', 'Status', 'Jobs', 'Created'],
    style: { head: ['cyan'] },
  });

  for (const chain of chains) {
    table.push([
      chalk.dim(shortId(chain.id)),
      chain.spec.name,
      chain.spec.strategy,
      colorStatus(chain.status),
      String(chain.jobIds.length),
      new Date(chain.createdAt).toLocaleString(),
    ]);
  }

  return table.toString();
}

/**
 * Format a detailed job status block.
 */
export function formatJobDetail(job: JobRecord): string {
  const lines: string[] = [];
  lines.push(chalk.bold(`Job: ${job.spec.name} (job#${job.slurmJobId ?? 'pending'})`));
  lines.push(`Status: ${colorStatus(job.status)}  Elapsed: ${formatElapsed(job.elapsed)}`);
  lines.push(`Partition: ${job.spec.resources.partition}  Node: ${job.node ?? 'N/A'}`);
  lines.push(`Alchemy ID: ${job.id}`);
  if (job.metrics && Object.keys(job.metrics).length > 0) {
    lines.push(`Metrics: ${formatMetrics(job.metrics)}`);
  }
  lines.push(`Created: ${new Date(job.createdAt).toLocaleString()}`);
  lines.push(`Updated: ${new Date(job.updatedAt).toLocaleString()}`);
  return lines.join('\n');
}

/**
 * Format a detailed chain status block with progress.
 */
export function formatChainDetail(chain: ChainRecord, jobs: JobRecord[]): string {
  const lines: string[] = [];
  lines.push(chalk.bold(`Chain: ${chain.spec.name}`));
  lines.push(`Strategy: ${chain.spec.strategy}  Status: ${colorStatus(chain.status)}`);
  lines.push('');

  const completed = jobs.filter(
    j => j.status === JobStatus.COMPLETED,
  ).length;
  const total = jobs.length;

  // Show each step
  for (const job of jobs) {
    const statusIcon = STATUS_EMOJI[job.status] ?? '❓';
    const metrics =
      job.metrics && Object.keys(job.metrics).length > 0
        ? `  ${formatMetrics(job.metrics)}`
        : '';
    const elapsed = job.elapsed ? `  ${formatElapsed(job.elapsed)}` : '';
    const running =
      job.status === JobStatus.RUNNING ? '  running...' : '';
    const waiting =
      job.status === JobStatus.PENDING ? '  waiting' : '';
    lines.push(
      `  ${statusIcon} ${job.spec.name.padEnd(20)}${elapsed}${metrics}${running}${waiting}`,
    );
  }

  lines.push('');
  lines.push(`Progress: ${progressBar(completed, total)} `);
  return lines.join('\n');
}
