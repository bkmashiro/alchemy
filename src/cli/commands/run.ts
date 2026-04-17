// src/cli/commands/run.ts

import { Command } from 'commander';
import { loadConfig } from '../../core/config.js';
import { AlchemyOrchestrator } from '../../core/orchestrator.js';
import type { JobSpec } from '../../core/types.js';

export function registerRunCommand(program: Command): void {
  program
    .command('run <command>')
    .description('Quick single-job submission without a YAML file')
    .option('-n, --name <name>', 'Job name')
    .option('-p, --partition <part>', 'Slurm partition', 't4')
    .option('-t, --time <HH:MM:SS>', 'Wall time', '01:00:00')
    .option('-m, --mem <mem>', 'Memory', '16G')
    .option('-g, --gpus <n>', 'Number of GPUs', '1')
    .option('--cpus <n>', 'CPUs per task')
    .option('-e, --env <K=V>', 'Extra env var (repeatable)', (v: string, prev: string[]) => [...prev, v], [] as string[])
    .option('--tag <tag>', 'Tag (repeatable)', (v: string, prev: string[]) => [...prev, v], [] as string[])
    .option('--config <path>', 'Config file path')
    .option('--dry-run', 'Print sbatch script only')
    .option('--watch', 'Poll status until done')
    .action(async (cmd: string, opts: {
      name?: string;
      partition: string;
      time: string;
      mem: string;
      gpus: string;
      cpus?: string;
      env: string[];
      tag: string[];
      config?: string;
      dryRun?: boolean;
      watch?: boolean;
    }) => {
      try {
        const config = loadConfig(opts.config);

        const envMap: Record<string, string> = {};
        for (const e of opts.env) {
          const [k, ...rest] = e.split('=');
          if (k) envMap[k] = rest.join('=');
        }

        const spec: JobSpec = {
          name: opts.name ?? `job_${Date.now()}`,
          command: cmd,
          resources: {
            partition: opts.partition,
            time: opts.time,
            mem: opts.mem,
            gpus: parseInt(opts.gpus, 10),
            cpusPerTask: opts.cpus ? parseInt(opts.cpus, 10) : undefined,
            env: Object.keys(envMap).length > 0 ? envMap : undefined,
          },
          tags: opts.tag.length > 0 ? opts.tag : undefined,
        };

        const orchestrator = new AlchemyOrchestrator(config);
        await orchestrator.initialize();
        try {
          const id = await orchestrator.submitJob(spec);
          console.log(`Submitted job: ${id}`);
        } finally {
          await orchestrator.destroy();
        }
      } catch (err) {
        console.error('Error:', err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
