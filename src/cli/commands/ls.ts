// src/cli/commands/ls.ts

import { Command } from 'commander';
import { loadConfig } from '../../core/config.js';
import { JobRegistry } from '../../core/registry.js';
import { JobStatus, ChainStatus } from '../../core/types.js';
import { formatJobTable, formatChainTable } from '../formatting.js';

export function registerLsCommand(program: Command): void {
  program
    .command('ls')
    .description('List jobs with filters')
    .option('--running', 'Show only running jobs')
    .option('--failed', 'Show only failed jobs')
    .option('--completed', 'Show only completed jobs')
    .option('--pending', 'Show only pending jobs')
    .option('--chains', 'List chains instead of jobs')
    .option('--tag <tag>', 'Filter by tag')
    .option('--limit <n>', 'Max results', '20')
    .option('--json', 'Output raw JSON')
    .option('--config <path>', 'Config file path')
    .action(async (opts: {
      running?: boolean;
      failed?: boolean;
      completed?: boolean;
      pending?: boolean;
      chains?: boolean;
      tag?: string;
      limit: string;
      json?: boolean;
      config?: string;
    }) => {
      try {
        const config = loadConfig(opts.config);
        const registry = new JobRegistry(config.registry.path);
        const limit = parseInt(opts.limit, 10);

        try {
          if (opts.chains) {
            let status: ChainStatus | undefined;
            if (opts.running) status = ChainStatus.RUNNING;
            else if (opts.failed) status = ChainStatus.FAILED;
            else if (opts.completed) status = ChainStatus.COMPLETED;
            else if (opts.pending) status = ChainStatus.PENDING;

            const { chains, total } = registry.listChains({ status, limit });
            if (opts.json) {
              console.log(JSON.stringify({ chains, total }));
            } else {
              console.log(`Chains (${chains.length}/${total}):`);
              console.log(formatChainTable(chains));
            }
          } else {
            let status: JobStatus | undefined;
            if (opts.running) status = JobStatus.RUNNING;
            else if (opts.failed) status = JobStatus.FAILED;
            else if (opts.completed) status = JobStatus.COMPLETED;
            else if (opts.pending) status = JobStatus.PENDING;

            const { jobs, total } = registry.listJobs({
              status,
              tags: opts.tag ? [opts.tag] : undefined,
              limit,
            });

            if (opts.json) {
              console.log(JSON.stringify({ jobs, total }));
            } else {
              console.log(`Jobs (${jobs.length}/${total}):`);
              console.log(formatJobTable(jobs));
            }
          }
        } finally {
          registry.close();
        }
      } catch (err) {
        console.error('Error:', err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
