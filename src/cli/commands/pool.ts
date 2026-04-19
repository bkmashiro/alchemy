// src/cli/commands/pool.ts
// alchemy pool — manage the task pool (pending job queue with priorities)

import { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import { loadConfig } from '../../core/config.js';
import { JobRegistry } from '../../core/registry.js';
import { Scheduler } from '../../core/scheduler.js';
import { PluginManager } from '../../core/plugin-manager.js';
import { shortId } from '../formatting.js';
import type { JobSpec } from '../../core/types.js';

// Ensure executors are registered
import '../../executors/index.js';

function openSimpleScheduler(configPath?: string): { scheduler: Scheduler; registry: JobRegistry; config: ReturnType<typeof loadConfig> } {
  let config;
  try {
    config = loadConfig(configPath);
  } catch (err) {
    console.error(chalk.red(`Config error: ${String(err)}`));
    process.exit(1);
  }
  const registry = new JobRegistry(config.registry.path);
  const scheduler = new Scheduler(config.registry.path, registry, new Map());
  return { scheduler, registry, config };
}

export function registerPoolCommand(program: Command): void {
  const pool = program
    .command('pool')
    .description('Manage the task pool (pending queue with priorities)');

  // alchemy pool list (default action)
  pool
    .command('list', { isDefault: true })
    .description('List pending jobs in the pool')
    .option('--config <path>', 'Path to alchemy config file')
    .action(async (opts: { config?: string }) => {
      const { scheduler, registry } = openSimpleScheduler(opts.config);
      try {
        const entries = scheduler.listPool();
        if (entries.length === 0) {
          console.log(chalk.dim('Pool is empty.'));
          return;
        }

        const table = new Table({
          head: ['Pool ID', 'Job ID', 'Name', 'Priority', 'Executor', 'Added'],
          style: { head: ['cyan'] },
        });

        for (const e of entries) {
          table.push([
            shortId(e.id),
            shortId(e.jobId),
            e.spec.name,
            String(e.priority),
            e.executorType,
            new Date(e.addedAt).toLocaleString(),
          ]);
        }

        console.log(table.toString());
      } finally {
        scheduler.close();
        registry.close();
      }
    });

  // alchemy pool add "<command>" [options]
  pool
    .command('add <command>')
    .description('Add a job to the pool')
    .option('--config <path>', 'Path to alchemy config file')
    .option('-n, --name <name>', 'Job name')
    .option('-p, --partition <part>', 'Slurm partition', 't4')
    .option('-t, --time <HH:MM:SS>', 'Wall time', '01:00:00')
    .option('-m, --mem <mem>', 'Memory', '16G')
    .option('-g, --gpus <n>', 'Number of GPUs', '1')
    .option('--priority <n>', 'Priority (higher = sooner)', '50')
    .option('--ws', 'Target workstation executor')
    .action(async (command: string, opts: {
      config?: string;
      name?: string;
      partition?: string;
      time?: string;
      mem?: string;
      gpus?: string;
      priority?: string;
      ws?: boolean;
    }) => {
      const name = opts.name
        ?? command.split(' ')[0]!.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 30) + '_' + Date.now().toString(36);
      const priority = parseInt(opts.priority ?? '50', 10);
      const executorType = opts.ws ? 'workstation_ssh' : 'slurm_ssh';

      const spec: JobSpec = {
        name,
        command,
        priority,
        resources: {
          partition: opts.partition ?? 't4',
          time: opts.time ?? '01:00:00',
          mem: opts.mem ?? '16G',
          gpus: parseInt(opts.gpus ?? '1', 10),
        },
      };

      const { scheduler, registry } = openSimpleScheduler(opts.config);
      try {
        const entry = scheduler.addToPool(spec, executorType, priority);
        console.log(chalk.green('Added to pool:'));
        console.log(`  Pool ID:  ${shortId(entry.id)}`);
        console.log(`  Job ID:   ${shortId(entry.jobId)}`);
        console.log(`  Name:     ${entry.spec.name}`);
        console.log(`  Priority: ${entry.priority}`);
        console.log(`  Executor: ${entry.executorType}`);
      } finally {
        scheduler.close();
        registry.close();
      }
    });

  // alchemy pool priority <pool-id> <priority>
  pool
    .command('priority <pool-id> <priority>')
    .description('Change the priority of a pool entry')
    .option('--config <path>', 'Path to alchemy config file')
    .action(async (poolId: string, priorityStr: string, opts: { config?: string }) => {
      const priority = parseInt(priorityStr, 10);
      if (isNaN(priority)) {
        console.error(chalk.red(`Invalid priority: ${priorityStr}`));
        process.exit(1);
      }

      const { scheduler, registry } = openSimpleScheduler(opts.config);
      try {
        scheduler.setPriority(poolId, priority);
        console.log(chalk.green(`Priority updated to ${priority} for pool entry ${shortId(poolId)}`));
      } catch (err) {
        console.error(chalk.red(String(err)));
        process.exit(1);
      } finally {
        scheduler.close();
        registry.close();
      }
    });

  // alchemy pool remove <pool-id>
  pool
    .command('remove <pool-id>')
    .description('Remove a job from the pool')
    .option('--config <path>', 'Path to alchemy config file')
    .action(async (poolId: string, opts: { config?: string }) => {
      const { scheduler, registry } = openSimpleScheduler(opts.config);
      try {
        scheduler.removeFromPool(poolId);
        console.log(chalk.green(`Removed pool entry ${shortId(poolId)}`));
      } catch (err) {
        console.error(chalk.red(String(err)));
        process.exit(1);
      } finally {
        scheduler.close();
        registry.close();
      }
    });

  // alchemy pool dispatch
  pool
    .command('dispatch')
    .description('Manually trigger dispatch of pending pool jobs')
    .option('--config <path>', 'Path to alchemy config file')
    .action(async (opts: { config?: string }) => {
      let config;
      try {
        config = loadConfig(opts.config);
      } catch (err) {
        console.error(chalk.red(`Config error: ${String(err)}`));
        process.exit(1);
      }

      const registry = new JobRegistry(config.registry.path);
      const executors = new Map();
      const pm = PluginManager.instance;

      const slurmExecutor = pm.createExecutor(config.executor.type, config.executor);
      await slurmExecutor.initialize();
      executors.set(config.executor.type, slurmExecutor);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wsConfig = (config as any).workstation;
      if (wsConfig) {
        const wsExecutor = pm.createExecutor('workstation_ssh', wsConfig);
        await wsExecutor.initialize();
        executors.set('workstation_ssh', wsExecutor);
      }

      const scheduler = new Scheduler(config.registry.path, registry, executors);

      try {
        console.log(chalk.cyan('Dispatching pending pool jobs...'));
        await scheduler.tryDispatch();
        console.log(chalk.green('Done.'));
      } finally {
        scheduler.close();
        for (const ex of executors.values()) {
          await ex.destroy();
        }
        registry.close();
      }
    });
}
