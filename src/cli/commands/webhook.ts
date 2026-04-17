// src/cli/commands/webhook.ts
// alchemy webhook [--port 3457] — start the webhook receiver server

import { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig } from '../../core/config.js';

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
      console.log(chalk.dim(`Public URL: ${config.webhook.publicUrl}`));
      console.log(chalk.dim(`Registered endpoint: ${config.webhook.publicUrl}/api/webhook/job-event`));

      try {
        // Dynamic import to avoid loading all of Agent B's code at startup
        const { createWebhookServer } = await import('../../webhook/server.js');

        // Orchestrator is required for the webhook server but is Agent A's responsibility.
        // For now, we create a minimal placeholder that logs events.
        const placeholderOrchestrator = {
          handleWebhookEvent: async (payload: unknown) => {
            console.log(chalk.dim(`Webhook received: ${JSON.stringify(payload)}`));
          },
        };

        await createWebhookServer(
          placeholderOrchestrator as never,
          port,
          config.webhook.secret,
        );

        console.log(chalk.green(`Webhook receiver running on port ${port}`));
        console.log(chalk.dim('Listening for job completion callbacks from the cluster.'));
        console.log(chalk.dim('Press Ctrl+C to stop.'));

        process.on('SIGINT', () => {
          console.log('\nShutting down webhook receiver...');
          process.exit(0);
        });

        process.on('SIGTERM', () => {
          process.exit(0);
        });

        await new Promise<void>(() => {});
      } catch (err) {
        // Graceful degradation if Agent B's webhook server isn't available yet
        console.error(chalk.yellow(`Note: Full webhook server requires Agent B's implementation.`));
        console.error(chalk.red(`Error: ${String(err)}`));
        process.exit(1);
      }
    });
}
