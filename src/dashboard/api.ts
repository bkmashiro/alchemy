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
import type { SlurmSSHExecutor, SlurmClusterStatus } from '../executors/slurm-ssh.js';

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
  // ─── GET /api/health ───────────────────────────────────────

  app.get('/api/health', async (_req: FastifyRequest, reply: FastifyReply) => {
    return reply.send({ status: 'ok', uptime: process.uptime() });
  });

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

    // Handle untracked SLURM jobs (id = "slurm-<jobId>")
    if (id.startsWith('slurm-')) {
      const slurmJobId = id.replace('slurm-', '');
      const slurmExecutor = executors.get('slurm_ssh');
      if (!slurmExecutor) {
        return reply.send({ logs: '(No SLURM executor available)' });
      }
      try {
        // Try common log patterns
        const logDir = '/vol/bitbucket/ys25/jema/logs';
        const findCmd = `ls -t ${logDir}/*${slurmJobId}*.log ${logDir}/*${slurmJobId}*.out 2>/dev/null | head -1`;
        const { stdout: logFile } = await (slurmExecutor as unknown as { execRemote(cmd: string): Promise<{ stdout: string; stderr: string }> }).execRemote(findCmd);
        if (logFile.trim()) {
          const logs = await slurmExecutor.fetchLogs(logFile.trim(), tailLines);
          return reply.send({ logs: logs || '(Log file is empty)' });
        }
        return reply.send({ logs: `(No log file found for SLURM job ${slurmJobId})` });
      } catch (err) {
        return reply.send({ logs: `(Failed to fetch SLURM logs: ${String(err)})` });
      }
    }

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
        const jobData = jobFile.job as Record<string, unknown>;
        const executorType = (typeof jobData.executorType === 'string' ? jobData.executorType : 'slurm_ssh');
        const id = registry.createJob(
          jobData as unknown as Parameters<typeof registry.createJob>[0],
          executorType,
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

  // ─── GET /api/cluster-status ────────────────────────────────

  let clusterCache: SlurmClusterStatus | null = null;
  const CLUSTER_CACHE_TTL = 5 * 60_000; // 5 min

  app.get('/api/cluster-status', async (_req: FastifyRequest, reply: FastifyReply) => {
    const slurmExecutor = executors.get('slurm_ssh') as SlurmSSHExecutor | undefined;
    if (!slurmExecutor) {
      return reply.send({ nodes: [], jobs: [], note: 'No SLURM executor configured' });
    }
    try {
      if (clusterCache && Date.now() - clusterCache.queriedAt < CLUSTER_CACHE_TTL) {
        return reply.send(clusterCache);
      }
      clusterCache = await slurmExecutor.getClusterStatus();
      return reply.send(clusterCache);
    } catch (err) {
      return reply.status(500).send({ error: `Failed to query cluster: ${String(err)}` });
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

  // ─── POST /api/jobs/:id/migrate ─────────────────────────────
  // Manual migrate: cancel current → resubmit to target (resumable jobs only)

  app.post('/api/jobs/:id/migrate', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { targetHost?: string };

    try {
      const job = registry.getJob(id);

      if (!job.spec.resumable) {
        return reply.status(400).send({ error: 'Job is not resumable — cannot migrate' });
      }

      if (job.status !== JobStatus.RUNNING && job.status !== JobStatus.SUBMITTED) {
        return reply.status(400).send({ error: `Job must be running/submitted to migrate (current: ${job.status})` });
      }

      const executor = getExecutorForJob(executors, job.executorType);

      // Cancel current job
      if (executor && job.slurmJobId) {
        try { await executor.cancel(job.slurmJobId); } catch { /* best effort */ }
      }
      registry.updateJob(id, { status: JobStatus.CANCELLED });

      // Create new job with same spec + resume flag
      const newSpec = { ...job.spec };
      if (newSpec.resumeCheckpoint && !newSpec.command.includes('--resume')) {
        newSpec.command += ' --resume';
      }
      if (body?.targetHost && job.executorType === 'workstation_ssh') {
        newSpec.metadata = { ...newSpec.metadata, targetHost: body.targetHost };
      }

      const newJobId = registry.createJob(newSpec, job.executorType);

      if (executor) {
        try {
          const result = await executor.submit(newJobId, newSpec);
          registry.updateJob(newJobId, {
            slurmJobId: result.externalJobId,
            status: JobStatus.SUBMITTED,
            logPath: result.logPath,
          });
          return reply.send({ ok: true, cancelled: id, newJobId, submitted: true, targetHost: body?.targetHost ?? 'auto' });
        } catch (err) {
          return reply.send({ ok: true, cancelled: id, newJobId, submitted: false, error: String(err) });
        }
      }

      return reply.send({ ok: true, cancelled: id, newJobId, submitted: false, note: 'No executor — new job created but not submitted' });
    } catch {
      return reply.status(404).send({ error: `Job not found: ${id}` });
    }
  });

  // ─── GET /api/jobs/:id/progress ────────────────────────────

  // Cache: jobId → { data, ts }
  const progressCache = new Map<string, { data: unknown; ts: number }>();
  const PROGRESS_CACHE_TTL = 30_000; // 30s

  /**
   * Parse tqdm-style progress from log text.
   * Matches: "Training:   5%|..| 22726/500000 [33:56<13:22:01, 9.92it/s]"
   */
  function parseTqdmFromLog(logText: string): { step: number; total: number; percent: number; eta: string } | null {
    // Get last tqdm line (may have \r)
    const lines = logText.replace(/\r/g, '\n').split('\n').filter(l => l.includes('%|'));
    if (lines.length === 0) return null;
    const line = lines[lines.length - 1]!;
    const m = line.match(/(\d+)%\|.*?\|\s*([\d,]+)\/([\d,]+)\s*\[([^\]<]+)<([^\],]+)/);
    if (!m) return null;
    return {
      percent: parseInt(m[1]!),
      step: parseInt(m[2]!.replace(/,/g, '')),
      total: parseInt(m[3]!.replace(/,/g, '')),
      eta: m[5]!.trim(),
    };
  }

  app.get('/api/jobs/:id/progress', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    try {
      // Check cache
      const cached = progressCache.get(id);
      if (cached && Date.now() - cached.ts < PROGRESS_CACHE_TTL) {
        return reply.send(cached.data);
      }

      const job = registry.getJob(id);
      if (job.status !== JobStatus.RUNNING) {
        return reply.send({ progress: null });
      }

      // Strategy 1: progressFile (if configured, workstation only)
      if (job.spec.progressFile && job.slurmJobId?.startsWith('ws:')) {
        const wsExecutor = executors.get('workstation_ssh') as WorkstationSSHExecutor | undefined;
        if (wsExecutor) {
          const hostname = job.slurmJobId.split(':')[1] ?? '';
          const raw = await wsExecutor.fetchProgress(hostname, job.spec.progressFile);
          if (raw) {
            const result = {
              progress: {
                step: raw.step,
                total: raw.total,
                percent: raw.total > 0 ? Math.round((raw.step / raw.total) * 1000) / 10 : 0,
                eta: raw.eta_seconds > 0 ? formatSeconds(raw.eta_seconds) : null,
              },
            };
            progressCache.set(id, { data: result, ts: Date.now() });
            return reply.send(result);
          }
        }
      }

      // Strategy 2: parse tqdm from log tail
      const executor = getExecutorForJob(executors, job.executorType);
      if (executor && job.logPath) {
        try {
          let logText: string;
          if (job.slurmJobId?.startsWith('ws:') && 'fetchLogsFromHost' in executor) {
            const hostname = job.slurmJobId.split(':')[1] ?? '';
            logText = await (executor as { fetchLogsFromHost(h: string, p: string, n?: number): Promise<string> }).fetchLogsFromHost(hostname, job.logPath, 5);
          } else {
            logText = await executor.fetchLogs(job.logPath, 5);
          }
          const parsed = parseTqdmFromLog(logText);
          if (parsed) {
            const result = { progress: parsed };
            progressCache.set(id, { data: result, ts: Date.now() });
            return reply.send(result);
          }
        } catch { /* ignore log fetch failures */ }
      }

      const noProgress = { progress: null };
      progressCache.set(id, { data: noProgress, ts: Date.now() });
      return reply.send(noProgress);
    } catch {
      return reply.status(404).send({ error: `Job not found: ${id}` });
    }
  });

  // ─── GET /api/jobs/running/progress ────────────────────────
  // Batch endpoint: returns progress for all running jobs

  app.get('/api/progress', async (_req: FastifyRequest, reply: FastifyReply) => {
    const { jobs } = registry.listJobs({ status: JobStatus.RUNNING, limit: 50 });
    const results: Record<string, unknown> = {};

    await Promise.allSettled(
      jobs.map(async (job) => {
        // Check cache
        const cached = progressCache.get(job.id);
        if (cached && Date.now() - cached.ts < PROGRESS_CACHE_TTL) {
          results[job.id] = cached.data;
          return;
        }

        // Parse from log tail
        const executor = getExecutorForJob(executors, job.executorType);
        if (!executor || !job.logPath) return;

        try {
          let logText: string;
          if (job.slurmJobId?.startsWith('ws:') && 'fetchLogsFromHost' in executor) {
            const hostname = job.slurmJobId.split(':')[1] ?? '';
            logText = await (executor as { fetchLogsFromHost(h: string, p: string, n?: number): Promise<string> }).fetchLogsFromHost(hostname, job.logPath, 5);
          } else {
            logText = await executor.fetchLogs(job.logPath, 5);
          }
          const parsed = parseTqdmFromLog(logText);
          const data = parsed ? { progress: parsed } : { progress: null };
          progressCache.set(job.id, { data, ts: Date.now() });
          results[job.id] = data;
        } catch { /* skip */ }
      }),
    );

    return reply.send(results);
  });
}

function formatSeconds(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h${m}m`;
  return `${m}m`;
}
