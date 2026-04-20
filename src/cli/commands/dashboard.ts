// src/cli/commands/dashboard.ts
// alchemy dashboard [--port 3456] — start the web dashboard server

import { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig } from '../../core/config.js';
import { JobRegistry } from '../../core/registry.js';
import { createDashboardServer } from '../../dashboard/server.js';
import { PluginManager } from '../../core/plugin-manager.js';
import { JobStatus, type JobRecord } from '../../core/types.js';
import type { BaseExecutor } from '../../executors/base.js';
import type { BaseNotifier } from '../../notifiers/base.js';
import { createScheduler, type Scheduler } from '../../core/scheduler.js';

export function registerDashboardCommand(program: Command): void {
  program
    .command('dashboard')
    .description('Start the web dashboard server')
    .option('--config <path>', 'Path to alchemy config file')
    .option('--port <n>', 'Port number (default: 3456)')
    .action(async (opts: { config?: string; port?: string }) => {
      let config;
      try {
        config = loadConfig(opts.config);
      } catch (err) {
        console.error(chalk.red(`Config error: ${String(err)}`));
        process.exit(1);
      }

      const port = opts.port
        ? parseInt(opts.port, 10)
        : (config.dashboard?.port ?? 3456);

      const registry = new JobRegistry(config.registry.path);

      // Initialize all configured executors
      const executors: Map<string, BaseExecutor> = new Map();
      const notifiers: BaseNotifier[] = [];
      let scheduler: Scheduler | undefined;
      let pollTimer: NodeJS.Timeout | undefined;

      try {
        await import('../../executors/index.js');
        await import('../../notifiers/index.js');
        const pm = PluginManager.instance;

        // Primary executor (slurm_ssh or local)
        try {
          const primary = pm.createExecutor(config.executor.type, config.executor);
          await primary.initialize();
          executors.set(config.executor.type, primary);
          console.log(chalk.green(`Primary executor [${config.executor.type}] connected.`));
        } catch (err) {
          console.log(chalk.yellow(`Primary executor init failed: ${String(err)}`));
        }

        // Workstation executor (if configured)
        if (config.workstation) {
          try {
            const ws = pm.createExecutor('workstation_ssh', config.workstation);
            await ws.initialize();
            executors.set('workstation_ssh', ws);
            console.log(chalk.green('Workstation executor connected.'));
          } catch (err) {
            console.log(chalk.yellow(`Workstation executor init failed: ${String(err)}`));
          }
        }

        // Set webhook public URL on all executors so sbatch scripts get absolute URLs
        const webhookPublicUrl = config.webhook?.publicUrl;
        if (webhookPublicUrl) {
          for (const exec of executors.values()) {
            if ('setWebhookPublicUrl' in exec) {
              (exec as unknown as { setWebhookPublicUrl(u: string): void }).setWebhookPublicUrl(webhookPublicUrl);
            }
          }
          console.log(chalk.green(`Webhook URL: ${webhookPublicUrl}`));
        } else {
          console.log(chalk.yellow('No webhook.publicUrl configured — sbatch notifications disabled.'));
        }

        // Initialize notifiers
        for (const notifierConfig of config.notifiers) {
          try {
            const notifier = pm.createNotifier(notifierConfig.type, notifierConfig);
            await notifier.initialize();
            notifiers.push(notifier);
            console.log(chalk.green(`Notifier [${notifierConfig.type}] initialized.`));
          } catch (err) {
            console.log(chalk.yellow(`Notifier init failed: ${String(err)}`));
          }
        }

        // Create scheduler for auto-dispatch
        scheduler = createScheduler(config.registry.path, registry, executors);

        if (executors.size > 0) {
          console.log(chalk.green(`${executors.size} executor(s), ${notifiers.length} notifier(s) — full mode.`));

          // Background status polling every 30s
          // Track when jobs first entered UNKNOWN state
          const unknownSince = new Map<string, number>();
          const UNKNOWN_TIMEOUT_MS = 5 * 60_000; // 5 min → mark as failed
          // Track jobs that have already been notified as "started" to avoid duplicates on restart
          const notifiedStarted = new Set<string>();

          // Pre-populate: jobs already RUNNING at startup don't need "started" notification
          {
            const { jobs: existingRunning } = registry.listJobs({ status: JobStatus.RUNNING, limit: 500 });
            for (const j of existingRunning) notifiedStarted.add(j.id);
          }

          const pollJobs = async () => {
            try {
              const { jobs } = registry.listJobs({
                status: [JobStatus.PENDING, JobStatus.SUBMITTED, JobStatus.RUNNING, JobStatus.UNKNOWN],
                limit: 200,
              });
              for (const job of jobs) {
                if (!job.slurmJobId) continue;
                const exec = executors.get(job.executorType);
                if (!exec) continue;
                try {
                  const result = await exec.status(job.slurmJobId);
                  if (result.status === job.status) continue;

                  // Handle UNKNOWN: track timeout, don't immediately update to UNKNOWN
                  if (result.status === JobStatus.UNKNOWN) {
                    if (!unknownSince.has(job.id)) {
                      unknownSince.set(job.id, Date.now());
                    }
                    const elapsed = Date.now() - unknownSince.get(job.id)!;
                    if (elapsed < UNKNOWN_TIMEOUT_MS) continue; // wait longer
                    // Timed out — mark as failed
                    result.status = JobStatus.FAILED;
                    unknownSince.delete(job.id);
                  } else {
                    unknownSince.delete(job.id);
                  }

                  registry.updateJob(job.id, {
                    status: result.status,
                    exitCode: result.exitCode,
                    node: result.node,
                    elapsed: result.elapsed,
                  });

                  const updatedJob = registry.getJob(job.id);

                  // Send notifications on status changes
                  for (const notifier of notifiers) {
                    try {
                      if (result.status === JobStatus.RUNNING && !notifiedStarted.has(job.id)) {
                        notifiedStarted.add(job.id);
                        await notifier.notifyJobStarted(updatedJob);
                      } else if (result.status === JobStatus.COMPLETED) {
                        await notifier.notifyJobCompleted(updatedJob);
                      } else if (
                        result.status === JobStatus.FAILED ||
                        result.status === JobStatus.TIMEOUT
                      ) {
                        // Fetch log tail for error context
                        let logTail = '';
                        if (updatedJob.logPath) {
                          try {
                            logTail = await exec.fetchLogs(updatedJob.logPath, 30);
                          } catch { /* ignore */ }
                        }
                        await notifier.notifyJobFailed(updatedJob, logTail);
                      }
                    } catch {
                      // skip notifier errors
                    }
                  }

                  // Auto-dispatch: when a job finishes, try to dispatch next from pool
                  if (
                    result.status === JobStatus.COMPLETED ||
                    result.status === JobStatus.FAILED ||
                    result.status === JobStatus.TIMEOUT
                  ) {
                    if (scheduler) {
                      scheduler.tryDispatch().catch(() => {});
                    }
                  }
                } catch {
                  // skip individual job failures
                }
              }
            } catch {
              // skip entire poll cycle failures
            }
          };
          pollTimer = setInterval(pollJobs, 30_000);
          void pollJobs();
        }
      } catch (err) {
        console.log(chalk.yellow(`Setup failed: ${String(err)}`));
        console.log(chalk.dim('Dashboard will run in read-only mode.'));
      }

      console.log(chalk.cyan(`Starting Alchemy Dashboard on port ${port}...`));

      try {
        await createDashboardServer(registry, port, executors, scheduler);
        console.log(chalk.green(`Dashboard running at: http://localhost:${port}`));
        console.log(chalk.dim('Press Ctrl+C to stop.'));

        const cleanup = () => {
          if (pollTimer) clearInterval(pollTimer);
          registry.close();
          for (const exec of executors.values()) {
            void exec.destroy().catch(() => {});
          }
          for (const n of notifiers) {
            void n.destroy().catch(() => {});
          }
        };

        process.on('SIGINT', () => {
          console.log('\nShutting down dashboard...');
          cleanup();
          process.exit(0);
        });

        process.on('SIGTERM', () => {
          cleanup();
          process.exit(0);
        });

        // Prevent silent crashes — log and exit so wrapper can restart
        process.on('uncaughtException', (err) => {
          console.error(chalk.red(`Uncaught exception: ${String(err)}`));
          console.error(err.stack);
          cleanup();
          process.exit(1);
        });

        process.on('unhandledRejection', (reason) => {
          console.error(chalk.red(`Unhandled rejection: ${String(reason)}`));
          if (reason instanceof Error) console.error(reason.stack);
          // Don't exit — log and continue; most rejections are non-fatal SSH errors
        });

        await new Promise<void>(() => {});
      } catch (err) {
        console.error(chalk.red(`Failed to start dashboard: ${String(err)}`));
        registry.close();
        for (const exec of executors.values()) {
          await exec.destroy().catch(() => {});
        }
        process.exit(1);
      }
    });
}
