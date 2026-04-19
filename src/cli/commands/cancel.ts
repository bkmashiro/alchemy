// src/cli/commands/cancel.ts
// alchemy cancel <job-id|chain-id> — cancel a running job or chain

import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig } from '../../core/config.js';
import { JobRegistry } from '../../core/registry.js';
import { JobStatus, ChainStatus } from '../../core/types.js';
import { shortId, colorStatus } from '../formatting.js';
import { PluginManager } from '../../core/plugin-manager.js';
import type { BaseExecutor } from '../../executors/base.js';

export function registerCancelCommand(program: Command): void {
  program
    .command('cancel <id>')
    .description('Cancel a running job or all jobs in a chain')
    .option('--config <path>', 'Path to alchemy config file')
    .option('--force', 'Skip confirmation prompt')
    .action(
      async (id: string, opts: { config?: string; force?: boolean }) => {
        let config;
        try {
          config = loadConfig(opts.config);
        } catch (err) {
          console.error(chalk.red(`Config error: ${String(err)}`));
          process.exit(1);
        }

        const registry = new JobRegistry(config.registry.path);

        // Try to initialize executor for actual cancellation
        let executor: BaseExecutor | null = null;
        try {
          // Import executors so they self-register
          await import('../../executors/index.js');
          const pm = PluginManager.instance;
          executor = pm.createExecutor(config.executor.type, config.executor);
          await executor.initialize();
        } catch (execErr) {
          console.log(chalk.yellow(`Note: Could not connect to executor (${String(execErr)})`));
          console.log(chalk.yellow('Will update registry status only; run scancel/kill manually if needed.'));
        }

        try {
          // Resolve ID — try job first, then chain
          const { jobs: allJobs } = registry.listJobs({ limit: 1000 });
          const matchingJobs = allJobs.filter(
            j => j.id === id || j.id.startsWith(id) || j.slurmJobId === id,
          );

          if (matchingJobs.length === 1) {
            const job = matchingJobs[0]!;

            if (
              job.status === JobStatus.COMPLETED ||
              job.status === JobStatus.CANCELLED ||
              job.status === JobStatus.FAILED
            ) {
              console.error(
                chalk.yellow(`Job ${shortId(job.id)} is already ${job.status} — cannot cancel.`),
              );
              process.exit(1);
            }

            if (!opts.force) {
              const rl = readline.createInterface({ input, output });
              const answer = await rl.question(
                `Cancel job ${chalk.bold(job.spec.name)} (${shortId(job.id)}, status: ${colorStatus(job.status)})? [y/N] `,
              );
              rl.close();
              if (!['y', 'yes'].includes(answer.toLowerCase())) {
                console.log('Cancelled.');
                return;
              }
            }

            if (executor && job.slurmJobId) {
              try {
                await executor.cancel(job.slurmJobId);
                console.log(chalk.green(`Cancelled job ${chalk.bold(job.spec.name)} (slurmId: ${job.slurmJobId})`));
              } catch (cancelErr) {
                console.log(chalk.yellow(`Executor cancel failed: ${String(cancelErr)}`));
                console.log(chalk.yellow('Updating registry status anyway.'));
              }
            } else if (!executor) {
              console.log(chalk.yellow(`No executor connection — updating registry status only.`));
              console.log(chalk.yellow(`Run scancel ${job.slurmJobId ?? 'N/A'} manually on the cluster.`));
            }
            registry.updateJob(job.id, { status: JobStatus.CANCELLED });
            console.log(chalk.green(`Registry updated: job ${shortId(job.id)} marked as cancelled`));
            return;
          } else if (matchingJobs.length > 1) {
            console.error(chalk.red(`Ambiguous ID: ${id} matches multiple jobs`));
            process.exit(1);
          }

          // Try as chain
          const { chains: allChains } = registry.listChains({ limit: 1000 });
          const matchingChains = allChains.filter(c => c.id === id || c.id.startsWith(id));

          if (matchingChains.length === 1) {
            const chain = matchingChains[0]!;

            if (
              chain.status === ChainStatus.COMPLETED ||
              chain.status === ChainStatus.CANCELLED
            ) {
              console.error(
                chalk.yellow(
                  `Chain ${shortId(chain.id)} is already ${chain.status} — cannot cancel.`,
                ),
              );
              process.exit(1);
            }

            const chainJobs = registry.getChainJobs(chain.id);
            const cancellable = chainJobs.filter(
              j =>
                j.status === JobStatus.RUNNING ||
                j.status === JobStatus.SUBMITTED ||
                j.status === JobStatus.PENDING,
            );

            if (!opts.force) {
              const rl = readline.createInterface({ input, output });
              const answer = await rl.question(
                `Cancel chain ${chalk.bold(chain.spec.name)} (${shortId(chain.id)}) and ${cancellable.length} active jobs? [y/N] `,
              );
              rl.close();
              if (!['y', 'yes'].includes(answer.toLowerCase())) {
                console.log('Cancelled.');
                return;
              }
            }

            let cancelledCount = 0;
            for (const job of cancellable) {
              if (executor && job.slurmJobId) {
                try {
                  await executor.cancel(job.slurmJobId);
                  cancelledCount++;
                } catch (cancelErr) {
                  console.log(chalk.yellow(`  Failed to cancel job ${shortId(job.id)} (${job.slurmJobId}): ${String(cancelErr)}`));
                }
              }
              registry.updateJob(job.id, { status: JobStatus.CANCELLED });
            }
            registry.updateChain(chain.id, { status: ChainStatus.CANCELLED });
            if (executor) {
              console.log(chalk.green(`Chain cancelled: ${cancelledCount}/${cancellable.length} jobs cancelled via executor`));
            } else {
              console.log(chalk.yellow(`No executor connection — registry updated, run scancel manually.`));
            }
            console.log(chalk.green(`Registry updated: chain ${shortId(chain.id)} marked as cancelled`));
            return;
          } else if (matchingChains.length > 1) {
            console.error(chalk.red(`Ambiguous ID: ${id} matches multiple chains`));
            process.exit(1);
          }

          console.error(chalk.red(`Not found: ${id}`));
          process.exit(1);
        } finally {
          registry.close();
          if (executor) {
            await executor.destroy().catch(() => {});
          }
        }
      },
    );
}
