// src/cli/commands/ls.ts
// alchemy ls [--running|--failed|--all] — list jobs/chains

import { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig } from '../../core/config.js';
import { JobRegistry } from '../../core/registry.js';
import { JobStatus, ChainStatus, type JobRecord, type ChainRecord } from '../../core/types.js';
import { formatJobTable, formatChainTable } from '../formatting.js';

export function registerLsCommand(program: Command): void {
  program
    .command('ls')
    .description('List jobs or chains with optional filters')
    .option('--config <path>', 'Path to alchemy config file')
    .option('--running', 'Show only running jobs')
    .option('--failed', 'Show only failed jobs')
    .option('--completed', 'Show only completed jobs')
    .option('--pending', 'Show only pending/submitted jobs')
    .option('--all', 'Show all jobs (default: last 20)')
    .option('--chains', 'List chains instead of jobs')
    .option('--tag <tag>', 'Filter by tag')
    .option('--limit <n>', 'Max results (default: 20)', '20')
    .option('--json', 'Output raw JSON')
    .action(
      async (opts: {
        config?: string;
        running?: boolean;
        failed?: boolean;
        completed?: boolean;
        pending?: boolean;
        all?: boolean;
        chains?: boolean;
        tag?: string;
        limit?: string;
        json?: boolean;
      }) => {
        let config;
        try {
          config = loadConfig(opts.config);
        } catch (err) {
          console.error(chalk.red(`Config error: ${String(err)}`));
          process.exit(1);
        }

        const limit = opts.all ? 1000 : parseInt(opts.limit ?? '20', 10);
        const registry = new JobRegistry(config.registry.path);

        try {
          if (opts.chains) {
            await listChains(registry, limit, opts.json ?? false);
          } else {
            await listJobs(registry, opts, limit, opts.json ?? false);
          }
        } finally {
          registry.close();
        }
      },
    );
}

async function listJobs(
  registry: JobRegistry,
  opts: {
    running?: boolean;
    failed?: boolean;
    completed?: boolean;
    pending?: boolean;
    tag?: string;
  },
  limit: number,
  asJson: boolean,
): Promise<void> {
  let statusFilter: JobStatus | JobStatus[] | undefined;

  if (opts.running) {
    statusFilter = JobStatus.RUNNING;
  } else if (opts.failed) {
    statusFilter = [JobStatus.FAILED, JobStatus.TIMEOUT];
  } else if (opts.completed) {
    statusFilter = JobStatus.COMPLETED;
  } else if (opts.pending) {
    statusFilter = [JobStatus.PENDING, JobStatus.SUBMITTED];
  }

  const { jobs, total } = registry.listJobs({
    status: statusFilter,
    tags: opts.tag ? [opts.tag] : undefined,
    limit,
  });

  if (asJson) {
    console.log(JSON.stringify({ jobs, total }, null, 2));
    return;
  }

  if (jobs.length === 0) {
    console.log(chalk.dim('No jobs found.'));
    return;
  }

  console.log(formatJobTable(jobs));

  if (total > jobs.length) {
    console.log(chalk.dim(`Showing ${jobs.length} of ${total} jobs. Use --limit or --all for more.`));
  } else {
    console.log(chalk.dim(`${total} job(s)`));
  }
}

async function listChains(
  registry: JobRegistry,
  limit: number,
  asJson: boolean,
): Promise<void> {
  const { chains, total } = registry.listChains({ limit });

  if (asJson) {
    console.log(JSON.stringify({ chains, total }, null, 2));
    return;
  }

  if (chains.length === 0) {
    console.log(chalk.dim('No chains found.'));
    return;
  }

  console.log(formatChainTable(chains));

  if (total > chains.length) {
    console.log(
      chalk.dim(`Showing ${chains.length} of ${total} chains. Use --limit for more.`),
    );
  } else {
    console.log(chalk.dim(`${total} chain(s)`));
  }
}
