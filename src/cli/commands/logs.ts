// src/cli/commands/logs.ts
// alchemy logs <job-id> [--tail N] [--follow] — fetch and display job logs

import { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig } from '../../core/config.js';
import { JobRegistry } from '../../core/registry.js';
import { JobStatus } from '../../core/types.js';
import { shortId } from '../formatting.js';

export function registerLogsCommand(program: Command): void {
  program
    .command('logs <job-id>')
    .description('Fetch and display job logs')
    .option('--config <path>', 'Path to alchemy config file')
    .option('--tail <n>', 'Number of lines to fetch from end', '50')
    .option('--follow', 'Continuously poll logs while job is running (like tail -f)')
    .option('--json', 'Output raw JSON')
    .action(
      async (
        jobId: string,
        opts: { config?: string; tail?: string; follow?: boolean; json?: boolean },
      ) => {
        let config;
        try {
          config = loadConfig(opts.config);
        } catch (err) {
          console.error(chalk.red(`Config error: ${String(err)}`));
          process.exit(1);
        }

        const tailLines = parseInt(opts.tail ?? '50', 10);
        const registry = new JobRegistry(config.registry.path);

        try {
          // Resolve job ID (support prefix)
          const { jobs: allJobs } = registry.listJobs({ limit: 1000 });
          const matching = allJobs.filter(
            j => j.id === jobId || j.id.startsWith(jobId) || j.slurmJobId === jobId,
          );

          if (matching.length === 0) {
            console.error(chalk.red(`Job not found: ${jobId}`));
            process.exit(1);
          }
          if (matching.length > 1) {
            console.error(chalk.red(`Ambiguous ID: ${jobId} matches multiple jobs`));
            process.exit(1);
          }

          const job = matching[0]!;

          if (!job.logPath) {
            console.error(
              chalk.yellow(
                `No log path recorded for job ${shortId(job.id)} (status: ${job.status})`,
              ),
            );
            process.exit(1);
          }

          if (opts.json) {
            console.log(
              JSON.stringify({
                jobId: job.id,
                jobName: job.spec.name,
                logPath: job.logPath,
                status: job.status,
                note: 'Log fetching requires SSH executor connection',
              }),
            );
            return;
          }

          console.log(
            chalk.dim(`# Logs for ${job.spec.name} (${shortId(job.id)}) — last ${tailLines} lines`),
          );
          console.log(chalk.dim(`# Log path: ${job.logPath}`));
          console.log(chalk.dim(`# Status: ${job.status}`));
          console.log('');

          if (opts.follow && job.status === JobStatus.RUNNING) {
            console.log(chalk.yellow('Note: --follow mode requires an active SSH executor.'));
            console.log(chalk.yellow('Showing static log info only.'));
          }

          // In real implementation, this would call executor.fetchLogs()
          console.log(
            chalk.yellow(
              '[Log retrieval requires an SSH executor connection. ' +
                'Start with: alchemy webhook then check logs via the dashboard.]',
            ),
          );
        } finally {
          registry.close();
        }
      },
    );
}
