#!/usr/bin/env node
// src/cli/index.ts

import { Command } from 'commander';

// Side-effect imports to register all plugins
import '../executors/index.js';
import '../notifiers/index.js';
import '../analyzers/index.js';
import '../strategies/index.js';

import { registerSubmitCommand } from './commands/submit.js';
import { registerRunCommand } from './commands/run.js';
import { registerStatusCommand } from './commands/status.js';
import { registerLogsCommand } from './commands/logs.js';
import { registerCancelCommand } from './commands/cancel.js';
import { registerLsCommand } from './commands/ls.js';
import { registerDashboardCommand } from './commands/dashboard.js';
import { registerWebhookCommand } from './commands/webhook.js';

const program = new Command()
  .name('alchemy')
  .description('ML job orchestration CLI for remote Slurm clusters')
  .version('0.1.0');

registerSubmitCommand(program);
registerRunCommand(program);
registerStatusCommand(program);
registerLogsCommand(program);
registerCancelCommand(program);
registerLsCommand(program);
registerDashboardCommand(program);
registerWebhookCommand(program);

program.parse();
