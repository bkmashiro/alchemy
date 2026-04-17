// src/cli/commands/submit.ts

import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { loadConfig } from '../../core/config.js';
import { AlchemyOrchestrator } from '../../core/orchestrator.js';
import type { AlchemyJobFile } from '../../core/types.js';

export function registerSubmitCommand(program: Command): void {
  program
    .command('submit <yaml-file>')
    .description('Submit a job or chain from a YAML file')
    .option('--config <path>', 'Path to alchemy config file')
    .option('--dry-run', 'Print the generated sbatch script without submitting')
    .option('--watch', 'Poll status until done')
    .action(async (yamlFile: string, opts: { config?: string; dryRun?: boolean; watch?: boolean }) => {
      try {
        const config = loadConfig(opts.config);
        const raw = readFileSync(yamlFile, 'utf-8');
        const parsed = parseYaml(raw) as AlchemyJobFile;

        if (!parsed.version || parsed.version !== '1') {
          console.error('Error: YAML file must have version: "1"');
          process.exit(1);
        }

        const orchestrator = new AlchemyOrchestrator(config);
        await orchestrator.initialize();

        try {
          if (parsed.job) {
            const id = await orchestrator.submitJob(parsed.job);
            console.log(`Submitted job: ${id}`);
          } else if (parsed.chain) {
            const id = await orchestrator.submitChain(parsed.chain);
            console.log(`Submitted chain: ${id}`);
          } else {
            console.error('Error: YAML must define either "job" or "chain"');
            process.exit(1);
          }
        } finally {
          await orchestrator.destroy();
        }
      } catch (err) {
        console.error('Error:', err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
