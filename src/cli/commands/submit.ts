// src/cli/commands/submit.ts
// alchemy submit <yaml-file> — submit a job or chain from a YAML file

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import chalk from 'chalk';
import { loadConfig } from '../../core/config.js';
import { JobRegistry } from '../../core/registry.js';
import type { AlchemyJobFile, JobSpec, ChainSpec } from '../../core/types.js';
import { shortId, formatJobDetail } from '../formatting.js';

// ─── Zod schema for AlchemyJobFile ───────────────────────────

const ResourceSpecSchema = z.object({
  partition: z.string().default('t4'),
  time: z.string().default('01:00:00'),
  mem: z.string().default('16G'),
  gpus: z.number().default(1),
  cpusPerTask: z.number().optional(),
  extraDirectives: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
});

const JobSpecSchema = z.object({
  name: z.string(),
  command: z.string(),
  resources: ResourceSpecSchema,
  workingDir: z.string().optional(),
  tags: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
  envBinPath: z.string().optional(),
  disableWebhook: z.boolean().optional(),
});

const ChainStepSpecSchema = z.object({
  stepId: z.string(),
  job: JobSpecSchema,
  dependsOn: z.array(z.string()).optional(),
  condition: z.string().optional(),
});

const ChainSpecSchema = z.object({
  name: z.string(),
  strategy: z.enum(['sequential', 'parallel', 'conditional', 'sweep']),
  steps: z.array(ChainStepSpecSchema).optional(),
  tags: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
  sweepGrid: z.record(z.array(z.union([z.string(), z.number()]))).optional(),
  sweepBaseJob: JobSpecSchema.optional(),
  maxConcurrent: z.number().optional(),
  failFast: z.boolean().optional(),
});

const AlchemyJobFileSchema = z.object({
  version: z.literal('1'),
  job: JobSpecSchema.optional(),
  chain: ChainSpecSchema.optional(),
});

export function registerSubmitCommand(program: Command): void {
  program
    .command('submit <yaml-file>')
    .description('Submit a job or chain from a YAML file')
    .option('--config <path>', 'Path to alchemy config file')
    .option('--dry-run', 'Validate YAML and print details without submitting')
    .option('--watch', 'Poll status every 5s after submitting until done')
    .action(async (yamlFile: string, opts: { config?: string; dryRun?: boolean; watch?: boolean }) => {
      const filePath = resolve(yamlFile);
      if (!existsSync(filePath)) {
        console.error(chalk.red(`Error: File not found: ${filePath}`));
        process.exit(1);
      }

      let raw: string;
      try {
        raw = readFileSync(filePath, 'utf-8');
      } catch (err) {
        console.error(chalk.red(`Error reading file: ${String(err)}`));
        process.exit(1);
      }

      let parsed: unknown;
      try {
        parsed = parseYaml(raw);
      } catch (err) {
        console.error(chalk.red(`Error parsing YAML: ${String(err)}`));
        process.exit(1);
      }

      const result = AlchemyJobFileSchema.safeParse(parsed);
      if (!result.success) {
        console.error(chalk.red('Invalid job file:'));
        console.error(result.error.message);
        process.exit(1);
      }

      const jobFile = result.data as AlchemyJobFile;

      if (!jobFile.job && !jobFile.chain) {
        console.error(chalk.red('Error: YAML must contain either `job:` or `chain:` key'));
        process.exit(1);
      }

      if (opts.dryRun) {
        console.log(chalk.cyan('Dry run — no submission will occur.'));
        if (jobFile.job) {
          console.log(chalk.bold('Single Job:'));
          console.log(JSON.stringify(jobFile.job, null, 2));
        } else if (jobFile.chain) {
          console.log(chalk.bold('Chain:'));
          console.log(JSON.stringify(jobFile.chain, null, 2));
        }
        return;
      }

      // Load config
      let config;
      try {
        config = loadConfig(opts.config);
      } catch (err) {
        console.error(chalk.red(`Config error: ${String(err)}`));
        process.exit(1);
      }

      const registry = new JobRegistry(config.registry.path);

      try {
        if (jobFile.job) {
          await submitSingleJob(jobFile.job as JobSpec, registry, opts.watch ?? false);
        } else if (jobFile.chain) {
          await submitChain(jobFile.chain as ChainSpec, registry);
        }
      } finally {
        registry.close();
      }
    });
}

async function submitSingleJob(
  spec: JobSpec,
  registry: JobRegistry,
  _watch: boolean,
): Promise<void> {
  console.log(chalk.cyan(`Submitting job: ${chalk.bold(spec.name)}`));
  console.log(`Command: ${spec.command}`);
  console.log(`Resources: partition=${spec.resources.partition} time=${spec.resources.time} mem=${spec.resources.mem} gpus=${spec.resources.gpus}`);

  try {
    const jobId = registry.createJob(spec, 'slurm_ssh');
    console.log(chalk.green(`\nJob created successfully!`));
    console.log(`Alchemy ID: ${chalk.bold(shortId(jobId))} (${jobId})`);
    console.log(`\nNote: Full job submission requires an executor (SSH connection).`);
    console.log(`Run 'alchemy status ${shortId(jobId)}' to check status.`);
  } catch (err) {
    // Registry stub will throw; show what would happen
    console.log(chalk.yellow('\n[Stub mode] Registry not fully initialized.'));
    console.log(`Would create job: ${spec.name}`);
    console.log(`  partition: ${spec.resources.partition}`);
    console.log(`  time: ${spec.resources.time}`);
    console.log(`  mem: ${spec.resources.mem}`);
    console.log(`  gpus: ${spec.resources.gpus}`);
    console.log(`  command: ${spec.command}`);
  }
}

async function submitChain(spec: ChainSpec, registry: JobRegistry): Promise<void> {
  console.log(chalk.cyan(`Submitting chain: ${chalk.bold(spec.name)}`));
  console.log(`Strategy: ${spec.strategy}`);

  if (spec.steps) {
    console.log(`Steps (${spec.steps.length}):`);
    for (const step of spec.steps) {
      const deps = step.dependsOn?.length ? ` → depends on [${step.dependsOn.join(', ')}]` : '';
      const cond = step.condition ? ` if: ${step.condition}` : '';
      console.log(`  ${step.stepId}: ${step.job.name}${deps}${cond}`);
    }
  }

  if (spec.sweepGrid) {
    const combos = Object.values(spec.sweepGrid).reduce((a, b) => a * b.length, 1);
    console.log(`Sweep grid: ${combos} combinations`);
    for (const [k, v] of Object.entries(spec.sweepGrid)) {
      console.log(`  ${k}: [${v.join(', ')}]`);
    }
  }

  try {
    const chainId = registry.createChain(spec);
    console.log(chalk.green(`\nChain created successfully!`));
    console.log(`Chain ID: ${chalk.bold(shortId(chainId))} (${chainId})`);
    console.log(`\nRun 'alchemy status ${shortId(chainId)}' to check progress.`);
  } catch (err) {
    console.log(chalk.yellow('\n[Stub mode] Registry not fully initialized.'));
    console.log(`Would create chain: ${spec.name} (${spec.strategy})`);
  }
}
