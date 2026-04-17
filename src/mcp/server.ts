// src/mcp/server.ts
// MCP server for agent tool-call access to Alchemy.
// Primary interface for AI agents (like Akashi) to manage ML jobs without using the CLI.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// Side-effect imports to register all plugins
import '../executors/index.js';
import '../notifiers/index.js';
import '../analyzers/index.js';
import '../strategies/index.js';

import { loadConfig } from '../core/config.js';
import { AlchemyOrchestrator } from '../core/orchestrator.js';
import { JobStatus, ChainStatus, ChainStrategyType, DEFAULT_RESOURCE_SPEC } from '../core/types.js';
import type {
  JobSpec,
  ChainSpec,
  ResourceSpec,
  ChainStepSpec,
} from '../core/types.js';

// ─── Shared sub-schemas ─────────────────────────────────────

const ResourceSpecSchema = z.object({
  partition: z.string().optional().describe("Slurm partition (e.g. 't4', 'a100')"),
  time: z.string().optional().describe("Wall-clock time limit (HH:MM:SS)"),
  mem: z.string().optional().describe("Memory allocation (e.g. '16G')"),
  gpus: z.number().int().optional().describe('Number of GPUs'),
  cpusPerTask: z.number().int().optional().describe('CPUs per task'),
  extraDirectives: z.array(z.string()).optional().describe('Extra Slurm directives'),
  env: z.record(z.string()).optional().describe('Environment variables'),
});

const JobSpecSchema = z.object({
  name: z.string().describe('Human-readable job name'),
  command: z.string().describe('Shell command to run'),
  resources: ResourceSpecSchema.optional(),
  tags: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const ChainStepSpecSchema = z.object({
  stepId: z.string().describe('Unique step ID within the chain'),
  job: JobSpecSchema,
  dependsOn: z.array(z.string()).optional().describe('Step IDs that must complete first'),
  condition: z.string().optional().describe("Condition expression, e.g. 'metrics.val_acc > 0.85'"),
});

// ─── Startup ─────────────────────────────────────────────────

let orchestrator: AlchemyOrchestrator | null = null;

async function getOrchestrator(): Promise<AlchemyOrchestrator> {
  if (!orchestrator) {
    throw new Error('Orchestrator not initialized');
  }
  return orchestrator;
}

// ─── MCP Server ──────────────────────────────────────────────

export async function startMcpServer(): Promise<void> {
  const config = loadConfig();

  orchestrator = new AlchemyOrchestrator(config);
  await orchestrator.initialize();

  const server = new McpServer(
    { name: 'alchemy', version: '0.1.0' },
    {
      instructions:
        'Alchemy MCP server — submit and monitor ML jobs on remote Slurm clusters. ' +
        'Use alchemy_submit_job to run a single job, alchemy_submit_chain for multi-step pipelines, ' +
        'and alchemy_job_status / alchemy_list_jobs to track progress.',
    },
  );

  // ── alchemy_submit_job ────────────────────────────────────

  server.registerTool(
    'alchemy_submit_job',
    {
      description: 'Submit a single ML job to the Slurm cluster. Returns alchemyJobId and slurmJobId.',
      inputSchema: {
        name: z.string().describe('Human-readable job name'),
        command: z.string().describe('Shell command to run (e.g. "python train.py --lr 1e-3")'),
        resources: ResourceSpecSchema.optional(),
        tags: z.array(z.string()).optional().describe('Tags for filtering'),
        metadata: z.record(z.unknown()).optional().describe('Arbitrary metadata'),
      },
    },
    async (args) => {
      const orch = await getOrchestrator();
      const spec: JobSpec = {
        name: args.name,
        command: args.command,
        resources: { ...DEFAULT_RESOURCE_SPEC, ...(args.resources as Partial<ResourceSpec> | undefined) },
        tags: args.tags,
        metadata: args.metadata as Record<string, unknown> | undefined,
      };

      const alchemyJobId = await orch.submitJob(spec);
      const registry = orch.getRegistry();
      const job = registry.getJob(alchemyJobId);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              alchemyJobId: job.id,
              slurmJobId: job.slurmJobId,
              status: job.status,
              name: job.spec.name,
            }),
          },
        ],
      };
    },
  );

  // ── alchemy_submit_chain ──────────────────────────────────

  server.registerTool(
    'alchemy_submit_chain',
    {
      description:
        'Submit a multi-step job chain. Supports sequential, parallel, conditional, and sweep strategies. Returns chainId.',
      inputSchema: {
        name: z.string().describe('Human-readable chain name'),
        strategy: z
          .enum([
            ChainStrategyType.SEQUENTIAL,
            ChainStrategyType.PARALLEL,
            ChainStrategyType.CONDITIONAL,
            ChainStrategyType.HYPERPARAM_SWEEP,
          ])
          .describe('Orchestration strategy'),
        steps: z
          .array(ChainStepSpecSchema)
          .describe('Steps in the chain'),
        tags: z.array(z.string()).optional(),
        metadata: z.record(z.unknown()).optional(),
        sweepGrid: z
          .record(z.array(z.union([z.string(), z.number()])))
          .optional()
          .describe('For sweep strategy: parameter grid, e.g. {"lr": [1e-3, 1e-4]}'),
        sweepBaseJob: JobSpecSchema.optional().describe(
          'For sweep strategy: base job spec with {{var}} placeholders',
        ),
        maxConcurrent: z.number().int().optional().describe('Max concurrent jobs'),
        failFast: z.boolean().optional().describe('Cancel remaining jobs on first failure'),
      },
    },
    async (args) => {
      const orch = await getOrchestrator();
      const spec: ChainSpec = {
        name: args.name,
        strategy: args.strategy as ChainStrategyType,
        steps: args.steps as ChainStepSpec[],
        tags: args.tags,
        metadata: args.metadata as Record<string, unknown> | undefined,
        sweepGrid: args.sweepGrid as Record<string, (string | number)[]> | undefined,
        sweepBaseJob: args.sweepBaseJob as JobSpec | undefined,
        maxConcurrent: args.maxConcurrent,
        failFast: args.failFast,
      };

      const chainId = await orch.submitChain(spec);
      const registry = orch.getRegistry();
      const chain = registry.getChain(chainId);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              chainId: chain.id,
              name: chain.spec.name,
              strategy: chain.spec.strategy,
              status: chain.status,
              stepCount: chain.spec.steps.length,
            }),
          },
        ],
      };
    },
  );

  // ── alchemy_job_status ────────────────────────────────────

  server.registerTool(
    'alchemy_job_status',
    {
      description:
        'Get detailed status, metrics, node assignment, and elapsed time for a job.',
      inputSchema: {
        jobId: z.string().describe('Alchemy job ID (or unique prefix)'),
      },
    },
    async (args) => {
      const orch = await getOrchestrator();
      const registry = orch.getRegistry();

      const { jobs: allJobs } = registry.listJobs({ limit: 1000 });
      const matching = allJobs.filter(
        (j) => j.id === args.jobId || j.id.startsWith(args.jobId) || j.slurmJobId === args.jobId,
      );

      if (matching.length === 0) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Job not found: ${args.jobId}` }) }],
          isError: true,
        };
      }
      if (matching.length > 1) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: `Ambiguous ID prefix: ${args.jobId} matches ${matching.length} jobs`,
                matches: matching.map((j) => ({ id: j.id, name: j.spec.name, status: j.status })),
              }),
            },
          ],
          isError: true,
        };
      }

      const job = matching[0]!;
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              id: job.id,
              slurmJobId: job.slurmJobId,
              name: job.spec.name,
              status: job.status,
              node: job.node,
              elapsed: job.elapsed,
              exitCode: job.exitCode,
              metrics: job.metrics,
              logPath: job.logPath,
              chainId: job.chainId,
              createdAt: job.createdAt,
              updatedAt: job.updatedAt,
            }),
          },
        ],
      };
    },
  );

  // ── alchemy_list_jobs ─────────────────────────────────────

  server.registerTool(
    'alchemy_list_jobs',
    {
      description: 'List jobs with optional status filter.',
      inputSchema: {
        status: z
          .enum([
            JobStatus.PENDING,
            JobStatus.SUBMITTED,
            JobStatus.RUNNING,
            JobStatus.COMPLETED,
            JobStatus.FAILED,
            JobStatus.CANCELLED,
            JobStatus.TIMEOUT,
            JobStatus.UNKNOWN,
          ])
          .optional()
          .describe('Filter by status'),
        limit: z.number().int().min(1).max(500).optional().describe('Max results (default 50)'),
        chainId: z.string().optional().describe('Filter to a specific chain'),
      },
    },
    async (args) => {
      const orch = await getOrchestrator();
      const registry = orch.getRegistry();

      const { jobs, total } = registry.listJobs({
        status: args.status as JobStatus | undefined,
        chainId: args.chainId,
        limit: args.limit ?? 50,
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              total,
              jobs: jobs.map((j) => ({
                id: j.id,
                slurmJobId: j.slurmJobId,
                name: j.spec.name,
                status: j.status,
                node: j.node,
                elapsed: j.elapsed,
                chainId: j.chainId,
                createdAt: j.createdAt,
              })),
            }),
          },
        ],
      };
    },
  );

  // ── alchemy_cancel_job ────────────────────────────────────

  server.registerTool(
    'alchemy_cancel_job',
    {
      description: 'Cancel a running job by ID. Calls scancel on the Slurm cluster.',
      inputSchema: {
        jobId: z.string().describe('Alchemy job ID (or unique prefix)'),
      },
    },
    async (args) => {
      const orch = await getOrchestrator();
      const registry = orch.getRegistry();

      const { jobs: allJobs } = registry.listJobs({ limit: 1000 });
      const matching = allJobs.filter(
        (j) => j.id === args.jobId || j.id.startsWith(args.jobId) || j.slurmJobId === args.jobId,
      );

      if (matching.length === 0) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Job not found: ${args.jobId}` }) }],
          isError: true,
        };
      }
      if (matching.length > 1) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: `Ambiguous ID prefix: ${args.jobId} matches ${matching.length} jobs`,
              }),
            },
          ],
          isError: true,
        };
      }

      const job = matching[0]!;

      const terminalStatuses: JobStatus[] = [
        JobStatus.COMPLETED,
        JobStatus.CANCELLED,
        JobStatus.FAILED,
        JobStatus.TIMEOUT,
      ];
      if (terminalStatuses.includes(job.status)) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: `Job ${job.id} is already ${job.status} — cannot cancel`,
              }),
            },
          ],
          isError: true,
        };
      }

      const executor = orch.getExecutor();
      if (job.slurmJobId) {
        await executor.cancel(job.slurmJobId);
      }
      registry.updateJob(job.id, { status: JobStatus.CANCELLED });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              jobId: job.id,
              slurmJobId: job.slurmJobId,
              name: job.spec.name,
              status: JobStatus.CANCELLED,
            }),
          },
        ],
      };
    },
  );

  // ── alchemy_fetch_logs ────────────────────────────────────

  server.registerTool(
    'alchemy_fetch_logs',
    {
      description: 'Fetch the last N lines of job logs from the cluster (default: 50 lines).',
      inputSchema: {
        jobId: z.string().describe('Alchemy job ID (or unique prefix)'),
        lines: z.number().int().min(1).max(2000).optional().describe('Number of lines to fetch (default: 50)'),
      },
    },
    async (args) => {
      const orch = await getOrchestrator();
      const registry = orch.getRegistry();

      const { jobs: allJobs } = registry.listJobs({ limit: 1000 });
      const matching = allJobs.filter(
        (j) => j.id === args.jobId || j.id.startsWith(args.jobId) || j.slurmJobId === args.jobId,
      );

      if (matching.length === 0) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Job not found: ${args.jobId}` }) }],
          isError: true,
        };
      }
      if (matching.length > 1) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: `Ambiguous ID prefix: ${args.jobId} matches ${matching.length} jobs`,
              }),
            },
          ],
          isError: true,
        };
      }

      const job = matching[0]!;

      if (!job.logPath) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: `No log path recorded for job ${job.id} (status: ${job.status})`,
              }),
            },
          ],
          isError: true,
        };
      }

      const tailLines = args.lines ?? 50;
      const executor = orch.getExecutor();
      const logs = await executor.fetchLogs(job.logPath, tailLines);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              jobId: job.id,
              name: job.spec.name,
              status: job.status,
              logPath: job.logPath,
              lines: tailLines,
              logs,
            }),
          },
        ],
      };
    },
  );

  // ── alchemy_list_chains ───────────────────────────────────

  server.registerTool(
    'alchemy_list_chains',
    {
      description: 'List job chains with their status and step counts.',
      inputSchema: {
        status: z
          .enum([
            ChainStatus.PENDING,
            ChainStatus.RUNNING,
            ChainStatus.COMPLETED,
            ChainStatus.FAILED,
            ChainStatus.CANCELLED,
            ChainStatus.PARTIAL,
          ])
          .optional()
          .describe('Filter by chain status'),
        limit: z.number().int().min(1).max(200).optional().describe('Max results (default 50)'),
      },
    },
    async (args) => {
      const orch = await getOrchestrator();
      const registry = orch.getRegistry();

      const { chains, total } = registry.listChains({
        status: args.status as ChainStatus | undefined,
        limit: args.limit ?? 50,
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              total,
              chains: chains.map((c) => ({
                id: c.id,
                name: c.spec.name,
                strategy: c.spec.strategy,
                status: c.status,
                stepCount: c.spec.steps.length,
                jobIds: c.jobIds,
                createdAt: c.createdAt,
                updatedAt: c.updatedAt,
              })),
            }),
          },
        ],
      };
    },
  );

  // ── Start transport ───────────────────────────────────────

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Graceful shutdown
  const shutdown = async () => {
    await orchestrator?.destroy();
    process.exit(0);
  };
  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
}
