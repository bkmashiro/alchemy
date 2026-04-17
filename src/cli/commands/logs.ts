// src/cli/commands/logs.ts

import { Command } from 'commander';
import { loadConfig } from '../../core/config.js';
import { JobRegistry } from '../../core/registry.js';
import { PluginManager } from '../../core/plugin-manager.js';

export function registerLogsCommand(program: Command): void {
  program
    .command('logs <job-id>')
    .description('Fetch and display job logs')
    .option('--tail <n>', 'Number of lines', '50')
    .option('--follow', 'Continuously poll')
    .option('--json', 'Output raw JSON')
    .option('--config <path>', 'Config file path')
    .action(async (jobId: string, opts: { tail: string; follow?: boolean; json?: boolean; config?: string }) => {
      try {
        const config = loadConfig(opts.config);
        const registry = new JobRegistry(config.registry.path);
        const tailLines = parseInt(opts.tail, 10);

        try {
          const job = registry.getJob(jobId);
          if (!job.logPath) {
            console.error('Log path not available yet');
            process.exit(1);
          }

          // Import executors for self-registration
          await import('../../executors/index.js');
          const executor = PluginManager.instance.createExecutor(config.executor.type, config.executor);
          await executor.initialize();

          try {
            const fetchAndPrint = async () => {
              const logs = await executor.fetchLogs(job.logPath!, tailLines);
              if (opts.json) {
                console.log(JSON.stringify({ logs }));
              } else {
                console.log(logs);
              }
            };

            await fetchAndPrint();

            if (opts.follow) {
              const interval = setInterval(async () => {
                const current = registry.getJob(jobId);
                await fetchAndPrint();
                if (current.status !== 'running' && current.status !== 'pending') {
                  clearInterval(interval);
                  await executor.destroy();
                  registry.close();
                }
              }, 2000);
            } else {
              await executor.destroy();
              registry.close();
            }
          } catch (err) {
            await executor.destroy();
            throw err;
          }
        } catch (err) {
          registry.close();
          throw err;
        }
      } catch (err) {
        console.error('Error:', err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
