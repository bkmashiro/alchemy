// src/cli/commands/dashboard.ts

import { Command } from 'commander';
import { loadConfig } from '../../core/config.js';

export function registerDashboardCommand(program: Command): void {
  program
    .command('dashboard')
    .description('Start the web dashboard server')
    .option('--port <n>', 'Port number')
    .option('--config <path>', 'Config file path')
    .action(async (opts: { port?: string; config?: string }) => {
      try {
        const config = loadConfig(opts.config);
        const port = opts.port ? parseInt(opts.port, 10) : (config.dashboard?.port ?? 3456);

        // Dynamic import for dashboard server (owned by Agent C)
        const { createDashboardServer } = await import('../../dashboard/server.js');
        const { JobRegistry } = await import('../../core/registry.js');

        const registry = new JobRegistry(config.registry.path);
        await createDashboardServer(registry, port);
        console.log(`Dashboard running at http://localhost:${port}`);
      } catch (err) {
        console.error('Error:', err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
