// src/cli/commands/status.ts

import { Command } from 'commander';
import { loadConfig } from '../../core/config.js';
import { JobRegistry } from '../../core/registry.js';
import { formatJobTable, formatChainTable, shortId, formatElapsed, colorStatus } from '../formatting.js';

export function registerStatusCommand(program: Command): void {
  program
    .command('status [id]')
    .description('Show status of a specific job or chain, or overall summary')
    .option('--config <path>', 'Config file path')
    .option('--json', 'Output raw JSON')
    .action(async (id: string | undefined, opts: { config?: string; json?: boolean }) => {
      try {
        const config = loadConfig(opts.config);
        const registry = new JobRegistry(config.registry.path);

        try {
          if (!id) {
            // Overall summary
            const { jobs: running } = registry.listJobs({ status: 'running' as never, limit: 1 });
            const { total: runningCount } = registry.listJobs({ status: 'running' as never, limit: 1 });
            const { total: pendingCount } = registry.listJobs({ status: 'pending' as never, limit: 1 });
            const { total: completedCount } = registry.listJobs({ status: 'completed' as never, limit: 1 });
            const { total: failedCount } = registry.listJobs({ status: 'failed' as never, limit: 1 });
            const { jobs: recent } = registry.listJobs({ limit: 5 });

            if (opts.json) {
              console.log(JSON.stringify({ running: runningCount, pending: pendingCount, completed: completedCount, failed: failedCount }));
            } else {
              console.log(`Running: ${runningCount} | Pending: ${pendingCount} | Completed: ${completedCount} | Failed: ${failedCount}`);
              console.log('\nRecent jobs:');
              console.log(formatJobTable(recent));
            }
            return;
          }

          // Try job first
          try {
            const job = registry.getJob(id);
            if (opts.json) {
              const events = registry.getEvents(id);
              console.log(JSON.stringify({ job, events }));
            } else {
              console.log(`Job: ${shortId(job.id)} (${job.id})`);
              console.log(`Name: ${job.spec.name}`);
              console.log(`Status: ${colorStatus(job.status)}`);
              console.log(`Slurm ID: ${job.slurmJobId ?? '—'}`);
              console.log(`Node: ${job.node ?? '—'}`);
              console.log(`Elapsed: ${formatElapsed(job.elapsed)}`);
              if (job.metrics) {
                console.log(`Metrics: ${JSON.stringify(job.metrics)}`);
              }
            }
            return;
          } catch {
            // try chain
          }

          try {
            const chain = registry.getChain(id);
            const chainJobs = registry.getChainJobs(id);
            if (opts.json) {
              console.log(JSON.stringify({ chain, jobs: chainJobs }));
            } else {
              console.log(`Chain: ${shortId(chain.id)} — ${chain.spec.name}`);
              console.log(`Strategy: ${chain.spec.strategy}`);
              console.log(`Status: ${colorStatus(chain.status)}`);
              console.log(formatJobTable(chainJobs));
            }
          } catch {
            console.error(`No job or chain found with ID: ${id}`);
            process.exit(1);
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
