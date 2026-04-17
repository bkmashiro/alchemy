// src/cli/commands/webhook.ts

import { Command } from 'commander';
import { loadConfig } from '../../core/config.js';
import { AlchemyOrchestrator } from '../../core/orchestrator.js';

export function registerWebhookCommand(program: Command): void {
  program
    .command('webhook')
    .description('Start the webhook receiver server')
    .option('--port <n>', 'Port number')
    .option('--config <path>', 'Config file path')
    .action(async (opts: { port?: string; config?: string }) => {
      try {
        const config = loadConfig(opts.config);
        const port = opts.port ? parseInt(opts.port, 10) : config.webhook.port;

        const orchestrator = new AlchemyOrchestrator(config);
        await orchestrator.initialize();

        // Dynamic import for webhook server (owned by Agent B)
        const { createWebhookServer } = await import('../../webhook/server.js');
        await createWebhookServer(orchestrator, port, config.webhook.secret);
        console.log(`Webhook receiver running at http://localhost:${port}`);

        // Graceful shutdown
        process.on('SIGINT', async () => {
          await orchestrator.destroy();
          process.exit(0);
        });
      } catch (err) {
        console.error('Error:', err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
