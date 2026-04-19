// src/dashboard/api.ts
// REST API route handlers for the dashboard.

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { JobRegistry } from '../core/registry.js';
import { JobStatus, ChainStatus } from '../core/types.js';
import type { BaseExecutor } from '../executors/base.js';
import type { Scheduler } from '../core/scheduler.js';
import type { WorkstationSSHExecutor } from '../executors/workstation-ssh.js';

// ─── Query param schemas ──────────────────────────────────────

const JobsQuerySchema = z.object({
  status: z.string().optional(),
  limit: z.string().optional().transform(v => (v ? parseInt(v, 10) : 50)),
  offset: z.string().optional().transform(v => (v ? parseInt(v, 10) : 0)),
  tag: z.string().optional(),
});

const ChainsQuerySchema = z.object({
  status: z.string().optional(),
  limit: z.string().optional().transform(v => (v ? parseInt(v, 10) : 20)),
  offset: z.string().optional().transform(v => (v ? parseInt(v, 10) : 0)),
});

const LogsQuerySchema = z.object({
  tail: z.string().optional().transform(v => (v ? parseInt(v, 10) : 50)),
});

/**
 * Resolve the executor for a given job based on its executorType.
 */
function getExecutorForJob(executors: Map<string, BaseExecutor>, executorType: string): BaseExecutor | undefined {
  return executors.get(executorType);
}

/**
 * Register all dashboard API routes.
 * @param executors Map of executor type → executor instance.
 * @param scheduler Optional task pool scheduler.
 */
export function registerApiRoutes(
  app: FastifyInstance,
  registry: JobRegistry,
  executors: Map<string, BaseExecutor>,
  scheduler?: Scheduler,
): void {
  // ─── GET /api/summary ──────────────────────────────────────

  app.get('/api/summary', async (_req: FastifyRequest, reply: FastifyReply) => {
    const { jobs: allJobs } = registry.listJobs({ limit: 10000 });
    const { chains } = registry.listChains({ limit: 10000 });

    const running = allJobs.filter(j => j.status === JobStatus.RUNNING).length;
    const pending = allJobs.filter(
      j => j.status === JobStatus.PENDING || j.status === JobStatus.SUBMITTED,
    ).length;
    const completed = allJobs.filter(j => j.status === JobStatus.COMPLETED).length;
    const failed = allJobs.filter(
      j => j.status === JobStatus.FAILED || j.status === JobStatus.TIMEOUT,
    ).length;
    const runningChains = chains.filter(c => c.status === ChainStatus.RUNNING).length;

    return reply.send({
      running,
      pending,
      completed,
      failed,
      total: allJobs.length,
      chains: chains.length,
      runningChains,
    });
  });

  // ─── GET /api/jobs ─────────────────────────────────────────

  app.get('/api/jobs', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = JobsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid query params' });
    }

    const { status, limit, offset, tag } = parsed.data;

    let statusFilter: JobStatus | JobStatus[] | undefined;
    if (status) {
      const validStatuses = Object.values(JobStatus) as string[];
      if (validStatuses.includes(status)) {
        statusFilter = status as JobStatus;
      }
    }

    const result = registry.listJobs({
      status: statusFilter,
      tags: tag ? [tag] : undefined,
      limit,
      offset,
    });

    return reply.send(result);
  });

  // ─── GET /api/jobs/:id ─────────────────────────────────────

  app.get('/api/jobs/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };

    try {
      const job = registry.getJob(id);
      const events = registry.getEvents(id);
      return reply.send({ job, events });
    } catch {
      return reply.status(404).send({ error: `Job not found: ${id}` });
    }
  });

  // ─── GET /api/jobs/:id/logs ────────────────────────────────

  app.get('/api/jobs/:id/logs', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const queryParsed = LogsQuerySchema.safeParse(req.query);
    const tailLines = queryParsed.success ? (queryParsed.data.tail ?? 50) : 50;

    try {
      const job = registry.getJob(id);

      if (!job.logPath) {
        return reply.send({ logs: '(No log path recorded for this job)' });
      }

      const executor = getExecutorForJob(executors, job.executorType);
      if (!executor) {
        return reply.send({
          logs:
            `[No executor available for type "${job.executorType}"]\n` +
            `Job: ${job.spec.name}\n` +
            `Status: ${job.status}\n` +
            `Log path: ${job.logPath}\n` +
            `\nUse 'alchemy logs ${id} --tail ${tailLines}' to fetch logs via CLI.`,
        });
      }

      // Use executor to fetch logs
      try {
        let logs: string;
        if (job.slurmJobId?.startsWith('ws:') && 'fetchLogsFromHost' in executor) {
          const parts = job.slurmJobId.split(':');
          const hostname = parts[1] ?? '';
          const wsExecutor = executor as { fetchLogsFromHost(hostname: string, logPath: string, tailLines?: number): Promise<string> };
          logs = await wsExecutor.fetchLogsFromHost(hostname, job.logPath, tailLines);
        } else {
          logs = await executor.fetchLogs(job.logPath, tailLines);
        }
        return reply.send({ logs: logs || '(Log file is empty or not yet written)' });
      } catch (fetchErr) {
        return reply.send({
          logs: `(Failed to fetch logs via SSH: ${String(fetchErr)})\nLog path: ${job.logPath}`,
        });
      }
    } catch {
      return reply.status(404).send({ error: `Job not found: ${id}` });
    }
  });

  // ─── POST /api/jobs/:id/cancel ─────────────────────────────

  app.post('/api/jobs/:id/cancel', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };

    try {
      const job = registry.getJob(id);

      if (
        job.status === JobStatus.COMPLETED ||
        job.status === JobStatus.CANCELLED ||
        job.status === JobStatus.FAILED ||
        job.status === JobStatus.TIMEOUT
      ) {
        return reply.status(400).send({ error: `Job is already in terminal state: ${job.status}` });
      }

      let executorCancelled = false;
      let executorError: string | undefined;

      const executor = getExecutorForJob(executors, job.executorType);
      if (executor && job.slurmJobId) {
        try {
          await executor.cancel(job.slurmJobId);
          executorCancelled = true;
        } catch (cancelErr) {
          executorError = String(cancelErr);
        }
      }

      registry.updateJob(id, { status: JobStatus.CANCELLED });

      return reply.send({
        ok: true,
        message: `Job ${job.spec.name} (${id}) cancelled`,
        executorCancelled,
        ...(executorError ? { executorError } : {}),
        ...(!executor ? { note: 'No executor connection — registry updated only.' } : {}),
      });
    } catch {
      return reply.status(404).send({ error: `Job not found: ${id}` });
    }
  });

  // ─── GET /api/chains ───────────────────────────────────────

  app.get('/api/chains', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = ChainsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid query params' });
    }

    const { status, limit, offset } = parsed.data;

    let statusFilter: ChainStatus | undefined;
    if (status) {
      const validStatuses = Object.values(ChainStatus) as string[];
      if (validStatuses.includes(status)) {
        statusFilter = status as ChainStatus;
      }
    }

    const result = registry.listChains({
      status: statusFilter,
      limit,
      offset,
    });

    return reply.send(result);
  });

  // ─── GET /api/chains/:id ───────────────────────────────────

  app.get('/api/chains/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };

    try {
      const chain = registry.getChain(id);
      const jobs = registry.getChainJobs(id);
      return reply.send({ chain, jobs });
    } catch {
      return reply.status(404).send({ error: `Chain not found: ${id}` });
    }
  });

  // ─── POST /api/submit ──────────────────────────────────────

  app.post('/api/submit', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as { yaml?: string };

    if (!body?.yaml) {
      return reply.status(400).send({ error: 'Missing yaml field in request body' });
    }

    let parsed: unknown;
    try {
      parsed = parseYaml(body.yaml);
    } catch (err) {
      return reply.status(400).send({ error: `Invalid YAML: ${String(err)}` });
    }

    const fileSchema = z.object({
      version: z.literal('1'),
      job: z.unknown().optional(),
      chain: z.unknown().optional(),
    });

    const fileResult = fileSchema.safeParse(parsed);
    if (!fileResult.success) {
      return reply.status(400).send({ error: 'Invalid job file format' });
    }

    const jobFile = fileResult.data;

    if (!jobFile.job && !jobFile.chain) {
      return reply.status(400).send({ error: 'YAML must contain job or chain key' });
    }

    try {
      if (jobFile.job) {
        const id = registry.createJob(
          jobFile.job as Parameters<typeof registry.createJob>[0],
          'slurm_ssh',
        );
        return reply.send({ id, type: 'job' });
      } else {
        const id = registry.createChain(
          jobFile.chain as Parameters<typeof registry.createChain>[0],
        );
        return reply.send({ id, type: 'chain' });
      }
    } catch (err) {
      return reply
        .status(500)
        .send({ error: `Failed to submit: ${String(err)}` });
    }
  });

  // ─── GET /api/gpu-status ───────────────────────────────────

  app.get('/api/gpu-status', async (_req: FastifyRequest, reply: FastifyReply) => {
    const wsExecutor = executors.get('workstation_ssh') as WorkstationSSHExecutor | undefined;
    if (!wsExecutor) {
      return reply.send({ hosts: [], note: 'No workstation executor configured' });
    }
    try {
      const hosts = await wsExecutor.getGpuStatus();
      return reply.send({ hosts });
    } catch (err) {
      return reply.status(500).send({ error: `Failed to query GPU status: ${String(err)}` });
    }
  });

  // ─── GET /api/pool ─────────────────────────────────────────

  app.get('/api/pool', async (_req: FastifyRequest, reply: FastifyReply) => {
    if (!scheduler) {
      return reply.send({ entries: [] });
    }
    const entries = scheduler.listPool();
    return reply.send({ entries });
  });

  // ─── POST /api/pool/add ────────────────────────────────────

  app.post('/api/pool/add', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!scheduler) {
      return reply.status(503).send({ error: 'Scheduler not available' });
    }
    const body = req.body as { spec?: unknown; executorType?: string; priority?: number };
    if (!body?.spec) {
      return reply.status(400).send({ error: 'Missing spec' });
    }
    try {
      const entry = scheduler.addToPool(
        body.spec as Parameters<typeof scheduler.addToPool>[0],
        body.executorType ?? 'slurm_ssh',
        body.priority,
      );
      return reply.send({ entry });
    } catch (err) {
      return reply.status(500).send({ error: String(err) });
    }
  });

  // ─── POST /api/pool/:id/priority ───────────────────────────

  app.post('/api/pool/:id/priority', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!scheduler) {
      return reply.status(503).send({ error: 'Scheduler not available' });
    }
    const { id } = req.params as { id: string };
    const body = req.body as { priority?: number };
    if (body?.priority === undefined || typeof body.priority !== 'number') {
      return reply.status(400).send({ error: 'Missing or invalid priority (must be a number)' });
    }
    try {
      scheduler.setPriority(id, body.priority);
      return reply.send({ ok: true });
    } catch (err) {
      return reply.status(404).send({ error: String(err) });
    }
  });

  // ─── DELETE /api/pool/:id ──────────────────────────────────

  app.delete('/api/pool/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!scheduler) {
      return reply.status(503).send({ error: 'Scheduler not available' });
    }
    const { id } = req.params as { id: string };
    try {
      scheduler.removeFromPool(id);
      return reply.send({ ok: true });
    } catch (err) {
      return reply.status(404).send({ error: String(err) });
    }
  });

  // ─── POST /api/pool/dispatch ───────────────────────────────

  app.post('/api/pool/dispatch', async (_req: FastifyRequest, reply: FastifyReply) => {
    if (!scheduler) {
      return reply.status(503).send({ error: 'Scheduler not available' });
    }
    try {
      await scheduler.tryDispatch();
      return reply.send({ ok: true });
    } catch (err) {
      return reply.status(500).send({ error: String(err) });
    }
  });

  // ─── GET /api/jobs/:id/progress ────────────────────────────

  app.get('/api/jobs/:id/progress', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    try {
      const job = registry.getJob(id);

      if (!job.spec.progressFile) {
        return reply.send({ progress: null, note: 'No progressFile configured for this job' });
      }

      if (!job.slurmJobId?.startsWith('ws:')) {
        return reply.send({ progress: null, note: 'Progress polling only supported for workstation jobs' });
      }

      const wsExecutor = executors.get('workstation_ssh') as WorkstationSSHExecutor | undefined;
      if (!wsExecutor) {
        return reply.send({ progress: null, note: 'No workstation executor' });
      }

      const parts = job.slurmJobId.split(':');
      const hostname = parts[1] ?? '';
      const raw = await wsExecutor.fetchProgress(hostname, job.spec.progressFile);
      if (!raw) {
        return reply.send({ progress: null });
      }

      const percent = raw.total > 0 ? Math.round((raw.step / raw.total) * 1000) / 10 : 0;
      return reply.send({
        progress: {
          step: raw.step,
          total: raw.total,
          elapsedSeconds: raw.elapsed_seconds,
          etaSeconds: raw.eta_seconds,
          percent,
        },
      });
    } catch {
      return reply.status(404).send({ error: `Job not found: ${id}` });
    }
  });
}
