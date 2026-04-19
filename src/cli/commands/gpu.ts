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

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wsConfig: WorkstationSSHExecutorConfig | undefined =
        config.executor.type === 'workstation_ssh'
          ? config.executor as WorkstationSSHExecutorConfig
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          : (config as any).workstation as WorkstationSSHExecutorConfig | undefined;

      if (!wsConfig) {
        console.error(chalk.red('GPU query requires a workstation_ssh executor or workstation: section in config.'));
        process.exit(1);
      }

      const executor = new WorkstationSSHExecutor(wsConfig);

      try {
        console.log(chalk.cyan('Connecting to hosts...'));
        await executor.initialize();

        const results = await executor.listAvailableHosts();

        const table = new Table({
          head: ['Host', 'GPU', 'VRAM Used/Total', 'GPU Util', 'Foreign', 'Status'],
          style: { head: ['cyan'] },
        });

        for (const r of results) {
          const usedGB = (r.memoryUsedMB / 1024).toFixed(1);
          const totalGB = (r.memoryTotalMB / 1024).toFixed(1);
          const vramStr = `${usedGB}/${totalGB} GB`;
          const utilStr = r.memoryTotalMB > 0 ? `${Math.round(r.gpuUtil)}%` : '—';
          const foreignStr = r.hasForeignProcess ? chalk.yellow('yes') : chalk.dim('no');
          const status = r.memoryTotalMB === 0
            ? chalk.red('unreachable')
            : r.hasForeignProcess
              ? chalk.yellow('foreign')
              : r.available
                ? chalk.green('available')
                : chalk.yellow('busy');

          table.push([
            r.host.name,
            r.host.gpuType,
            vramStr,
            utilStr,
            foreignStr,
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
