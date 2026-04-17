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

            // In production, this calls executor.cancel(job.slurmJobId!)
            // then registry.updateJob(job.id, { status: JobStatus.CANCELLED })
            console.log(
              chalk.yellow(
                `[Stub] Would cancel job ${chalk.bold(job.spec.name)} (slurmId: ${job.slurmJobId ?? 'N/A'})`,
              ),
            );
            console.log(chalk.yellow('Note: Actual cancellation requires an SSH executor connection.'));
            console.log(chalk.yellow('Run scancel manually if needed, or restart with an active executor.'));
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

            console.log(
              chalk.yellow(
                `[Stub] Would cancel chain ${chalk.bold(chain.spec.name)} and ${cancellable.length} active jobs.`,
              ),
            );
            console.log(chalk.yellow('Note: Actual cancellation requires an SSH executor connection.'));
            return;
          } else if (matchingChains.length > 1) {
            console.error(chalk.red(`Ambiguous ID: ${id} matches multiple chains`));
            process.exit(1);
          }

          console.error(chalk.red(`Not found: ${id}`));
          process.exit(1);
        } finally {
          registry.close();
        }
      },
    );
}
