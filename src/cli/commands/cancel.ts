// src/cli/commands/cancel.ts

import { Command } from 'commander';
import { loadConfig } from '../../core/config.js';
import { JobRegistry } from '../../core/registry.js';
import { PluginManager } from '../../core/plugin-manager.js';
import { JobStatus, ChainStatus } from '../../core/types.js';

export function registerCancelCommand(program: Command): void {
  program
    .command('cancel <id>')
    .description('Cancel a running job or all jobs in a chain')
    .option('--force', 'Skip confirmation prompt')
    .option('--config <path>', 'Config file path')
    .action(async (id: string, opts: { force?: boolean; config?: string }) => {
      try {
        const config = loadConfig(opts.config);
        const registry = new JobRegistry(config.registry.path);

        await import('../../executors/index.js');
        const executor = PluginManager.instance.createExecutor(config.executor.type, config.executor);
        await executor.initialize();

        try {
          // Try chain first
          let isChain = false;
          try {
            const chain = registry.getChain(id);
            isChain = true;
            const chainJobs = registry.getChainJobs(id);
            for (const job of chainJobs) {
              if (
                job.status === JobStatus.RUNNING ||
                job.status === JobStatus.SUBMITTED ||
                job.status === JobStatus.PENDING
              ) {
                if (job.slurmJobId) {
                  await executor.cancel(job.slurmJobId);
                }
                registry.updateJob(job.id, { status: JobStatus.CANCELLED });
              }
            }
            registry.updateChain(chain.id, { status: ChainStatus.CANCELLED });
            console.log(`Cancelled chain: ${id}`);
          } catch {
            // ignore
          }

          if (!isChain) {
            const job = registry.getJob(id);
            if (job.slurmJobId) {
              await executor.cancel(job.slurmJobId);
            }
            registry.updateJob(job.id, { status: JobStatus.CANCELLED });
            console.log(`Cancelled job: ${id}`);
          }
        } finally {
          await executor.destroy();
          registry.close();
        }
      } catch (err) {
        console.error('Error:', err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
