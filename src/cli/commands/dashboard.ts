// src/cli/commands/dashboard.ts
// alchemy dashboard [--port 3456] — start the web dashboard server

import { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig } from '../../core/config.js';
import { JobRegistry } from '../../core/registry.js';
import { createDashboardServer } from '../../dashboard/server.js';

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

      console.log(chalk.cyan(`Starting Alchemy Dashboard on port ${port}...`));

      try {
        await createDashboardServer(registry, port);
        console.log(chalk.green(`Dashboard running at: http://localhost:${port}`));
        console.log(chalk.dim('Press Ctrl+C to stop.'));

        // Keep process alive
        process.on('SIGINT', () => {
          console.log('\nShutting down dashboard...');
          registry.close();
          process.exit(0);
        });

        process.on('SIGTERM', () => {
          registry.close();
          process.exit(0);
        });

        // Block forever
        await new Promise<void>(() => {});
      } catch (err) {
        console.error(chalk.red(`Failed to start dashboard: ${String(err)}`));
        registry.close();
        process.exit(1);
      }
    });
}
