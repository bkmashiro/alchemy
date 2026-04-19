// src/cli/commands/gpu.ts
// alchemy gpu — query GPU usage on all configured workstation hosts

import { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import { loadConfig } from '../../core/config.js';
import { WorkstationSSHExecutor } from '../../executors/workstation-ssh.js';
import type { WorkstationSSHExecutorConfig } from '../../core/types.js';

export function registerGpuCommand(program: Command): void {
  program
    .command('gpu')
    .description('Query GPU usage on all configured workstation hosts')
    .option('--config <path>', 'Path to alchemy config file')
    .action(async (opts: { config?: string }) => {
      let config;
      try {
        config = loadConfig(opts.config);
      } catch (err) {
        console.error(chalk.red(`Config error: ${String(err)}`));
        process.exit(1);
      }

      if (config.executor.type !== 'workstation_ssh') {
        console.error(chalk.red('GPU query requires a workstation_ssh executor in config.'));
        process.exit(1);
      }

      const wsConfig = config.executor as WorkstationSSHExecutorConfig;
      const executor = new WorkstationSSHExecutor(wsConfig);

      try {
        console.log(chalk.cyan('Connecting to hosts...'));
        await executor.initialize();

        const results = await executor.listAvailableHosts();

        const table = new Table({
          head: ['Host', 'GPU', 'VRAM Used/Total', 'Status'],
          style: { head: ['cyan'] },
        });

        for (const r of results) {
          const usedGB = (r.memoryUsedMB / 1024).toFixed(1);
          const totalGB = (r.memoryTotalMB / 1024).toFixed(1);
          const vramStr = `${usedGB}/${totalGB} GB`;
          const status = r.memoryTotalMB === 0
            ? chalk.red('unreachable')
            : r.available
              ? chalk.green('available')
              : chalk.yellow('busy');

          table.push([
            r.host.name,
            r.host.gpuType,
            vramStr,
            status,
          ]);
        }

        console.log(table.toString());
      } catch (err) {
        console.error(chalk.red(`Error: ${String(err)}`));
        process.exit(1);
      } finally {
        await executor.destroy();
      }
    });
}
