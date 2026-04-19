// src/cli/commands/webhook.ts
// alchemy webhook [--port 3457] — start the webhook receiver server

import { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig } from '../../core/config.js';
import { tunnelManager } from '../../tunnel/index.js';

export function registerWebhookCommand(program: Command): void {
  program
    .command('webhook')
    .description('Start the webhook receiver server for job completion callbacks')
    .option('--config <path>', 'Path to alchemy config file')
    .option('--port <n>', 'Port number (default: 3457)')
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
        : (config.webhook.port ?? 3457);

      console.log(chalk.cyan(`Starting Alchemy Webhook Receiver on port ${port}...`));

      // Attempt to start a tunnel
      let webhookPublicUrl: string | null = null;
      let usingPolling = false;

      try {
        webhookPublicUrl = await tunnelManager.start(port);
      } catch (err) {
        console.error(chalk.yellow(`Tunnel error: ${String(err)}`));
      }

      if (webhookPublicUrl) {
        console.log(chalk.green(`Tunnel: ${webhookPublicUrl}`));
        console.log(chalk.dim(`Registered endpoint: ${webhookPublicUrl}/api/webhook/job-event`));
      } else {
        console.log(chalk.yellow('No tunnel available, falling back to polling'));
        usingPolling = true;
      }

      try {
        // Dynamic import to avoid loading all of Agent B's code at startup
        const { createWebhookServer } = await import('../../webhook/server.js');
        const { AlchemyOrchestrator } = await import('../../core/orchestrator.js');

        const orchestrator = new AlchemyOrchestrator(config);
        try {
          await orchestrator.initialize();
        } catch (initErr) {
          console.log(chalk.yellow(`Executor init deferred: ${String(initErr)}`));
          console.log(chalk.dim('Webhook server will still receive events; executor features unavailable until connection succeeds.'));
        }

        if (webhookPublicUrl) {
          const intervalMs = 5 * 60 * 1000;
          orchestrator.startPolling(intervalMs);
          console.log(chalk.dim('Polling every 5m (backup)'));
        } else {
          const intervalMs = 30_000;
          orchestrator.startPolling(intervalMs);
          console.log(chalk.dim('Polling every 30s (primary)'));
        }

        const effectivePublicUrl = webhookPublicUrl ?? config.webhook.publicUrl;
        console.log(chalk.dim(`Public URL: ${effectivePublicUrl}`));

        await createWebhookServer(
          orchestrator,
          port,
          config.webhook.secret,
        );

        console.log(chalk.green(`Webhook receiver running on port ${port}`));
        console.log(chalk.dim('Listening for job completion callbacks from the cluster.'));
        console.log(chalk.dim('Press Ctrl+C to stop.'));

        const shutdown = async () => {
          console.log('\nShutting down webhook receiver...');
          tunnelManager.stop();
          orchestrator.stopPolling();
          await orchestrator.destroy();
          process.exit(0);
        };

        process.on('SIGINT', () => { void shutdown(); });
        process.on('SIGTERM', () => { void shutdown(); });

        await new Promise<void>(() => {});
      } catch (err) {
        // Graceful degradation if Agent B's webhook server isn't available yet
        console.error(chalk.yellow(`Note: Full webhook server requires Agent B's implementation.`));
        console.error(chalk.red(`Error: ${String(err)}`));
        tunnelManager.stop();
        process.exit(1);
      }
    });
}
