// src/cli/commands/status.ts
// alchemy status [job-id|chain-id] — show job/chain status

import { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig } from '../../core/config.js';
import { JobRegistry } from '../../core/registry.js';
import { JobStatus, ChainStatus } from '../../core/types.js';
import {
  colorStatus,
  shortId,
  formatElapsed,
  formatMetrics,
  formatJobDetail,
  formatChainDetail,
  progressBar,
} from '../formatting.js';

export function registerStatusCommand(program: Command): void {
  program
    .command('status [id]')
    .description('Show status of a job, chain, or overall summary')
    .option('--config <path>', 'Path to alchemy config file')
    .option('--refresh', 'Query executor for live status (updates registry)')
    .option('--json', 'Output raw JSON')
    .action(async (id: string | undefined, opts: { config?: string; refresh?: boolean; json?: boolean }) => {
      let config;
      try {
        config = loadConfig(opts.config);
      } catch (err) {
        console.error(chalk.red(`Config error: ${String(err)}`));
        process.exit(1);
      }

      const registry = new JobRegistry(config.registry.path);

      try {
        if (!id) {
          await showSummary(registry, opts.json ?? false);
        } else {
          await showDetails(id, registry, opts.json ?? false);
        }
      } catch (err) {
        console.error(chalk.red(`Error: ${String(err)}`));
        process.exit(1);
      } finally {
        registry.close();
      }
    });
}

async function showSummary(registry: JobRegistry, asJson: boolean): Promise<void> {
  const { jobs: allJobs } = registry.listJobs({ limit: 1000 });

  const running = allJobs.filter(j => j.status === JobStatus.RUNNING).length;
  const pending = allJobs.filter(
    j => j.status === JobStatus.PENDING || j.status === JobStatus.SUBMITTED,
  ).length;
  const completed = allJobs.filter(j => j.status === JobStatus.COMPLETED).length;
  const failed = allJobs.filter(
    j => j.status === JobStatus.FAILED || j.status === JobStatus.TIMEOUT,
  ).length;

  const { chains } = registry.listChains({ limit: 1000 });
  const runningChains = chains.filter(c => c.status === ChainStatus.RUNNING).length;

  if (asJson) {
    console.log(JSON.stringify({ running, pending, completed, failed, total: allJobs.length, chains: chains.length, runningChains }));
    return;
  }

  console.log(chalk.bold('Alchemy — Job Summary'));
  console.log('─'.repeat(40));
  console.log(`  ${colorStatus(JobStatus.RUNNING).padEnd(20)}  ${running}`);
  console.log(`  ${colorStatus(JobStatus.PENDING).padEnd(20)}  ${pending}`);
  console.log(`  ${colorStatus(JobStatus.COMPLETED).padEnd(20)}  ${completed}`);
  console.log(`  ${colorStatus(JobStatus.FAILED).padEnd(20)}  ${failed}`);
  console.log(`  Total:                 ${allJobs.length}`);

  if (chains.length > 0) {
    console.log('');
    console.log(chalk.bold('Chains:'));
    for (const chain of chains.slice(0, 5)) {
      console.log(
        `  ${chalk.dim(shortId(chain.id))}  ${chain.spec.name.padEnd(20)}  ${colorStatus(chain.status)}`,
      );
    }
    if (chains.length > 5) {
      console.log(`  ... and ${chains.length - 5} more`);
    }
  }

  const recentJobs = allJobs.slice(0, 5);
  if (recentJobs.length > 0) {
    console.log('');
    console.log(chalk.bold('Recent Jobs:'));
    for (const job of recentJobs) {
      const elapsed = job.elapsed ? `  ${formatElapsed(job.elapsed)}` : '';
      console.log(
        `  ${chalk.dim(shortId(job.id))}  ${job.spec.name.padEnd(20)}  ${colorStatus(job.status)}${elapsed}`,
      );
    }
  }
}

async function showDetails(
  id: string,
  registry: JobRegistry,
  asJson: boolean,
): Promise<void> {
  // Try to find as job first, then chain
  let foundJob = false;
  let foundChain = false;

  // Search by prefix in all jobs
  const { jobs: allJobs } = registry.listJobs({ limit: 1000 });
  const matchingJobs = allJobs.filter(
    j => j.id === id || j.id.startsWith(id) || j.slurmJobId === id,
  );

  if (matchingJobs.length === 1) {
    foundJob = true;
    const job = matchingJobs[0]!;

    if (asJson) {
      const events = registry.getEvents(job.id);
      console.log(JSON.stringify({ job, events }, null, 2));
      return;
    }

    console.log(formatJobDetail(job));

    const events = registry.getEvents(job.id);
    if (events.length > 0) {
      console.log('');
      console.log(chalk.bold('Event Timeline:'));
      for (const event of events) {
        const ts = new Date(event.timestamp).toLocaleTimeString();
        console.log(`  ${chalk.dim(ts)}  ${event.type}`);
      }
    }
    return;
  } else if (matchingJobs.length > 1) {
    console.error(chalk.red(`Ambiguous ID prefix: ${id} matches multiple jobs`));
    process.exit(1);
  }

  // Try as chain
  const { chains: allChains } = registry.listChains({ limit: 1000 });
  const matchingChains = allChains.filter(
    c => c.id === id || c.id.startsWith(id),
  );

  if (matchingChains.length === 1) {
    foundChain = true;
    const chain = matchingChains[0]!;

    if (asJson) {
      const jobs = registry.getChainJobs(chain.id);
      console.log(JSON.stringify({ chain, jobs }, null, 2));
      return;
    }

    const jobs = registry.getChainJobs(chain.id);
    console.log(formatChainDetail(chain, jobs));
    return;
  } else if (matchingChains.length > 1) {
    console.error(chalk.red(`Ambiguous ID prefix: ${id} matches multiple chains`));
    process.exit(1);
  }

  if (!foundJob && !foundChain) {
    console.error(chalk.red(`Not found: ${id}`));
    process.exit(1);
  }
}
