// src/cli/commands/run.ts
// alchemy run "<command>" [options] — quick single-job submission without YAML

import { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig } from '../../core/config.js';
import { JobRegistry } from '../../core/registry.js';
import { PluginManager } from '../../core/plugin-manager.js';
import { JobStatus, type JobSpec } from '../../core/types.js';
import { shortId } from '../formatting.js';

// Ensure executors are registered
import '../../executors/index.js';

export function registerRunCommand(program: Command): void {
  program
    .command('run <command>')
    .description('Quick single-job submission without a YAML file')
    .option('--config <path>', 'Path to alchemy config file')
    .option('-n, --name <name>', 'Job name (default: auto-generated from command)')
    .option('-p, --partition <part>', 'Slurm partition', 't4')
    .option('-t, --time <HH:MM:SS>', 'Wall time', '01:00:00')
    .option('-m, --mem <mem>', 'Memory', '16G')
    .option('-g, --gpus <n>', 'Number of GPUs', '1')
    .option('--cpus <n>', 'CPUs per task')
    .option('-e, --env <K=V>', 'Extra env var (repeatable)', collectEnvVars, [])
    .option('--tag <tag>', 'Tag (repeatable)', collectTags, [])
    .option('--ws', 'Submit to a workstation instead of SLURM')
    .option('--host <host>', 'Target workstation host (default: auto)')
    .option('--dry-run', 'Print job spec without submitting')
    .option('--watch', 'Poll status until done')
    .action(
      async (
        command: string,
        opts: {
          config?: string;
          name?: string;
          partition?: string;
          time?: string;
          mem?: string;
          gpus?: string;
          cpus?: string;
          env?: string[];
          tag?: string[];
          ws?: boolean;
          host?: string;
          dryRun?: boolean;
          watch?: boolean;
        },
      ) => {
        // Auto-generate name from command if not provided
        const name =
          opts.name ??
          command
            .split(' ')[0]!
            .replace(/[^a-zA-Z0-9_-]/g, '_')
            .slice(0, 30) +
            '_' +
            Date.now().toString(36);

        // Parse env vars from K=V strings
        const envRecord: Record<string, string> = {};
        for (const kv of opts.env ?? []) {
          const idx = kv.indexOf('=');
          if (idx > 0) {
            const k = kv.slice(0, idx);
            const v = kv.slice(idx + 1);
            if (k) envRecord[k] = v;
          }
        }

        const spec: JobSpec = {
          name,
          command,
          resources: {
            partition: opts.partition ?? 't4',
            time: opts.time ?? '01:00:00',
            mem: opts.mem ?? '16G',
            gpus: parseInt(opts.gpus ?? '1', 10),
            cpusPerTask: opts.cpus ? parseInt(opts.cpus, 10) : undefined,
            env: Object.keys(envRecord).length > 0 ? envRecord : undefined,
          },
          tags: opts.tag?.length ? opts.tag : undefined,
        };

        if (opts.dryRun) {
          console.log(chalk.cyan('Dry run — job spec:'));
          console.log(JSON.stringify(spec, null, 2));
          return;
        }

        let config;
        try {
          config = loadConfig(opts.config);
        } catch (err) {
          console.error(chalk.red(`Config error: ${String(err)}`));
          process.exit(1);
        }

        console.log(chalk.cyan(`Submitting job: ${chalk.bold(name)}`));
        console.log(`Command:   ${command}`);
        console.log(`Partition: ${spec.resources.partition}`);
        console.log(`Time:      ${spec.resources.time}`);
        console.log(`Memory:    ${spec.resources.mem}`);
        console.log(`GPUs:      ${spec.resources.gpus}`);

        // Determine executor type and config
        const useWorkstation = opts.ws === true;
        const executorType = useWorkstation ? 'workstation_ssh' : config.executor.type;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const executorConfig = useWorkstation ? (config as any).workstation : config.executor;

        if (useWorkstation && !executorConfig) {
          console.error(chalk.red('No workstation config found in alchemy.config.yaml'));
          process.exit(1);
        }

        // Set target host in metadata for workstation executor
        if (useWorkstation && opts.host) {
          spec.metadata = { ...spec.metadata, targetHost: opts.host };
        }

        const registry = new JobRegistry(config.registry.path);
        try {
          const jobId = registry.createJob(spec, executorType);

          // Actually submit to executor
          const pm = PluginManager.instance;
          const executor = pm.createExecutor(executorType, executorConfig);
          await executor.initialize();

          try {
            const result = await executor.submit(jobId, spec);
            registry.updateJob(jobId, {
              slurmJobId: result.externalJobId,
              status: JobStatus.SUBMITTED,
              logPath: result.logPath,
            });
            console.log(chalk.green(`\nJob submitted: ${chalk.bold(shortId(jobId))}`));
            console.log(`External ID: ${result.externalJobId}`);
            console.log(`Log: ${result.logPath}`);
            console.log(`\nRun 'alchemy status ${shortId(jobId)}' to check status.`);
          } finally {
            await executor.destroy();
          }
        } catch (err) {
          console.error(chalk.red(`Submit failed: ${String(err)}`));
          process.exit(1);
        } finally {
          registry.close();
        }
      },
    );
}

function collectEnvVars(val: string, prev: string[]): string[] {
  return [...prev, val];
}

function collectTags(val: string, prev: string[]): string[] {
  return [...prev, val];
}
