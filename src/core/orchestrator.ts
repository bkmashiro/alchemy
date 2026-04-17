// src/core/orchestrator.ts

import pino from 'pino';
import {
  AlchemyConfig,
  AlchemyJobId,
  AlchemyChainId,
  JobSpec,
  ChainSpec,
  ChainStatus,
  JobStatus,
  JobEventType,
  AnalysisResult,
  WebhookPayload,
  ChainStrategyType,
} from './types.js';
import { JobRegistry } from './registry.js';
import { EventBus } from './event-bus.js';
import { ChainPlanner } from './chain-planner.js';
import { PluginManager } from './plugin-manager.js';
import { createLogger } from './logger.js';
import type { BaseExecutor } from '../executors/base.js';
import type { BaseNotifier } from '../notifiers/base.js';
import type { BaseAnalyzer } from '../analyzers/base.js';
import type { BaseChainStrategy } from '../strategies/base.js';

export class AlchemyOrchestrator {
  private registry: JobRegistry;
  private executor!: BaseExecutor;
  private notifiers: BaseNotifier[] = [];
  private analyzers: BaseAnalyzer[] = [];
  private strategies: Map<string, BaseChainStrategy> = new Map();
  private eventBus: EventBus;
  private chainPlanner: ChainPlanner;
  private config: AlchemyConfig;
  private logger: pino.Logger;
  private initialized = false;
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(config: AlchemyConfig) {
    this.config = config;
    this.registry = new JobRegistry(config.registry.path);
    this.eventBus = new EventBus();
    this.chainPlanner = new ChainPlanner();
    this.logger = createLogger('Orchestrator');
  }

  /**
   * Initialize all components: executor, notifiers, analyzers.
   * Must be called before any operations.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    const pm = PluginManager.instance;

    // Create executor
    this.executor = pm.createExecutor(this.config.executor.type, this.config.executor);
    await this.executor.initialize();

    // Create notifiers
    for (const notifierConfig of this.config.notifiers) {
      const notifier = pm.createNotifier(notifierConfig.type, notifierConfig);
      await notifier.initialize();
      this.notifiers.push(notifier);
    }

    // Create analyzers (sorted by priority)
    for (const analyzerConfig of this.config.analyzers ?? []) {
      const analyzer = pm.createAnalyzer(analyzerConfig.type, analyzerConfig);
      this.analyzers.push(analyzer);
    }
    this.analyzers.sort((a, b) => a.priority - b.priority);

    // Register all strategies
    for (const type of Object.values(ChainStrategyType)) {
      try {
        const strategy = pm.createStrategy(type);
        this.strategies.set(type, strategy);
      } catch {
        // Strategy not registered — that's OK, Agent B handles this
      }
    }

    this.initialized = true;
    this.logger.info('Orchestrator initialized');
  }

  /**
   * Submit a single job. Creates the record, submits via executor, returns job ID.
   */
  async submitJob(
    spec: JobSpec,
    chainId?: AlchemyChainId,
    chainIndex?: number,
    stepId?: string,
  ): Promise<AlchemyJobId> {
    const alchemyJobId = this.registry.createJob(
      spec,
      this.executor.type,
      chainId,
      chainIndex,
      stepId,
    );

    this.registry.addEvent({
      jobId: alchemyJobId,
      type: JobEventType.CREATED,
      timestamp: new Date().toISOString(),
      payload: { name: spec.name },
    });

    try {
      const { externalJobId, logPath } = await this.executor.submit(alchemyJobId, spec);

      this.registry.updateJob(alchemyJobId, {
        slurmJobId: externalJobId,
        status: JobStatus.SUBMITTED,
        logPath,
      });

      this.registry.addEvent({
        jobId: alchemyJobId,
        type: JobEventType.SUBMITTED,
        timestamp: new Date().toISOString(),
        payload: { slurmJobId: externalJobId, logPath },
      });

      await this.eventBus.emit({
        jobId: alchemyJobId,
        type: JobEventType.SUBMITTED,
        timestamp: new Date().toISOString(),
        payload: { slurmJobId: externalJobId },
      });

      this.logger.info({ alchemyJobId, slurmJobId: externalJobId, name: spec.name }, 'Job submitted');
      return alchemyJobId;
    } catch (err) {
      this.registry.updateJob(alchemyJobId, { status: JobStatus.FAILED });
      this.registry.addEvent({
        jobId: alchemyJobId,
        type: JobEventType.FAILED,
        timestamp: new Date().toISOString(),
        payload: { error: String(err) },
      });
      throw err;
    }
  }

  /**
   * Submit a chain. Validates, creates chain record, submits initial steps.
   */
  async submitChain(spec: ChainSpec): Promise<AlchemyChainId> {
    this.chainPlanner.validateChain(spec);

    const chainId = this.registry.createChain(spec);

    // Get the strategy
    const strategy = this.strategies.get(spec.strategy);
    if (!strategy) {
      throw new Error(
        `Strategy "${spec.strategy}" not registered. Make sure executors/index.ts is imported.`,
      );
    }

    // Get initial ready steps
    const nextSteps = strategy.getNextSteps(spec, new Map(), new Map());

    let position = 0;
    for (const step of nextSteps.ready) {
      const jobId = await this.submitJob(step.job, chainId, position, step.stepId);
      this.registry.linkJobToChain(chainId, jobId, step.stepId, position);
      position++;
    }

    this.registry.updateChain(chainId, { status: ChainStatus.RUNNING });
    this.logger.info({ chainId, name: spec.name, strategy: spec.strategy }, 'Chain submitted');
    return chainId;
  }

  /**
   * Handle an incoming webhook event from the cluster.
   */
  async handleWebhookEvent(payload: WebhookPayload): Promise<void> {
    const job = payload.alchemyJobId
      ? (() => {
          try { return this.registry.getJob(payload.alchemyJobId!); }
          catch { return null; }
        })()
      : this.registry.getJobBySlurmId(payload.jobId);

    if (!job) {
      this.logger.warn({ payload }, 'Webhook received for unknown job');
      return;
    }

    // Map status
    const statusMap: Record<string, JobStatus> = {
      started: JobStatus.RUNNING,
      completed: JobStatus.COMPLETED,
      failed: JobStatus.FAILED,
      timeout: JobStatus.TIMEOUT,
    };
    const newStatus = statusMap[payload.status] ?? JobStatus.UNKNOWN;

    // Update job
    this.registry.updateJob(job.id, {
      status: newStatus,
      exitCode: payload.exitCode,
      node: payload.node,
      elapsed: payload.elapsed,
    });

    // Emit event
    const eventTypeMap: Record<string, JobEventType> = {
      started: JobEventType.STARTED,
      completed: JobEventType.COMPLETED,
      failed: JobEventType.FAILED,
      timeout: JobEventType.TIMEOUT,
    };
    await this.eventBus.emit({
      jobId: job.id,
      type: eventTypeMap[payload.status] ?? JobEventType.COMPLETED,
      timestamp: new Date().toISOString(),
      payload: { slurmJobId: payload.jobId, node: payload.node, exitCode: payload.exitCode },
    });

    this.registry.addEvent({
      jobId: job.id,
      type: eventTypeMap[payload.status] ?? JobEventType.COMPLETED,
      timestamp: new Date().toISOString(),
      payload: { slurmJobId: payload.jobId, node: payload.node, exitCode: payload.exitCode, status: payload.status },
    });

    // Terminal status handling
    if (
      newStatus === JobStatus.COMPLETED ||
      newStatus === JobStatus.FAILED ||
      newStatus === JobStatus.TIMEOUT
    ) {
      await this.handleTerminalJob(this.registry.getJob(job.id), newStatus);
    }

    // Started status → notify
    if (newStatus === JobStatus.RUNNING) {
      const updatedJob = this.registry.getJob(job.id);
      for (const notifier of this.notifiers) {
        try {
          await notifier.notifyJobStarted(updatedJob);
        } catch (err) {
          this.logger.error({ notifierType: notifier.type, err }, 'Notifier failed');
        }
      }
    }
  }

  /**
   * Handle a job that has reached a terminal state (COMPLETED/FAILED/TIMEOUT).
   * Fetches logs, runs analyzers, sends notifications, and advances the chain.
   */
  private async handleTerminalJob(
    job: import('./types.js').JobRecord,
    newStatus: JobStatus,
    elapsed?: number,
  ): Promise<void> {
    // Apply optional elapsed update from polling
    if (elapsed !== undefined) {
      this.registry.updateJob(job.id, { elapsed });
    }
    const updatedJob = this.registry.getJob(job.id);

    // Fetch logs
    let logContent = '';
    if (updatedJob.logPath) {
      try {
        logContent = await this.executor.fetchLogs(updatedJob.logPath, 200);
      } catch (err) {
        this.logger.warn({ jobId: job.id, err }, 'Failed to fetch logs');
      }
    }

    // Run analyzer chain
    let analysisResult: AnalysisResult = {
      jobId: job.id,
      metrics: {},
      shouldContinueChain: newStatus === JobStatus.COMPLETED,
      summary: '',
    };
    for (const analyzer of this.analyzers) {
      analysisResult = await analyzer.analyze(updatedJob, logContent, analysisResult);
    }

    // Store metrics
    if (Object.keys(analysisResult.metrics).length > 0) {
      this.registry.setMetrics(job.id, analysisResult.metrics);
      this.registry.updateJob(job.id, { metrics: analysisResult.metrics });
    }

    // Notify
    for (const notifier of this.notifiers) {
      try {
        if (newStatus === JobStatus.COMPLETED) {
          await notifier.notifyJobCompleted(updatedJob);
        } else {
          const logTail = logContent.split('\n').slice(-20).join('\n');
          await notifier.notifyJobFailed(updatedJob, logTail);
        }
      } catch (err) {
        this.logger.error({ notifierType: notifier.type, err }, 'Notifier failed');
      }
    }

    // Advance chain if applicable
    if (updatedJob.chainId) {
      await this.advanceChain(updatedJob.chainId, analysisResult);
    }
  }

  /**
   * Start periodic polling for PENDING/RUNNING/SUBMITTED jobs.
   * Used as fallback when no webhook tunnel is available.
   * @param intervalMs - poll interval in ms (default 30000)
   */
  startPolling(intervalMs = 30_000): void {
    if (this.pollTimer !== null) return;
    this.logger.info({ intervalMs }, 'Starting polling fallback');
    this.pollTimer = setInterval(() => {
      this.pollJobs().catch((err) => {
        this.logger.error({ err }, 'Error during poll cycle');
      });
    }, intervalMs);
  }

  /** Stop polling */
  stopPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
      this.logger.info('Polling stopped');
    }
  }

  /** Poll all active jobs and handle any that have reached a terminal state */
  private async pollJobs(): Promise<void> {
    const { jobs } = this.registry.listJobs({
      status: [JobStatus.PENDING, JobStatus.SUBMITTED, JobStatus.RUNNING],
      limit: 200,
    });

    for (const job of jobs) {
      if (!job.slurmJobId) continue;
      try {
        const result = await this.executor.status(job.slurmJobId);
        if (result.status === job.status) continue;

        this.logger.info(
          { jobId: job.id, slurmJobId: job.slurmJobId, oldStatus: job.status, newStatus: result.status },
          'Job status changed (poll)',
        );

        this.registry.updateJob(job.id, {
          status: result.status,
          exitCode: result.exitCode,
          node: result.node,
          elapsed: result.elapsed,
        });

        const isTerminal =
          result.status === JobStatus.COMPLETED ||
          result.status === JobStatus.FAILED ||
          result.status === JobStatus.TIMEOUT ||
          result.status === JobStatus.CANCELLED;

        if (isTerminal) {
          await this.handleTerminalJob(this.registry.getJob(job.id), result.status, result.elapsed);
        }
      } catch (err) {
        this.logger.warn({ jobId: job.id, slurmJobId: job.slurmJobId, err }, 'Failed to poll job status');
      }
    }
  }

  /**
   * Advance a chain after a job completes.
   */
  private async advanceChain(
    chainId: AlchemyChainId,
    _latestAnalysis: AnalysisResult,
  ): Promise<void> {
    const chain = this.registry.getChain(chainId);
    const jobsByStepId = this.registry.getChainJobsByStepId(chainId);

    // Collect all analysis results for completed jobs
    const analysisResults = new Map<string, AnalysisResult>();
    for (const [stepId, jobRecord] of jobsByStepId) {
      if (jobRecord.metrics) {
        analysisResults.set(stepId, {
          jobId: jobRecord.id,
          metrics: jobRecord.metrics,
          shouldContinueChain: jobRecord.status === JobStatus.COMPLETED,
          summary: '',
        });
      }
    }

    // Get strategy
    const strategy = this.strategies.get(chain.spec.strategy);
    if (!strategy) {
      this.logger.error({ strategy: chain.spec.strategy }, 'Unknown chain strategy');
      return;
    }

    const nextSteps = strategy.getNextSteps(chain.spec, jobsByStepId, analysisResults);

    // Submit ready steps
    const currentPosition = chain.jobIds.length;
    for (const step of nextSteps.ready) {
      const jobId = await this.submitJob(step.job, chainId, currentPosition, step.stepId);
      this.registry.linkJobToChain(chainId, jobId, step.stepId, currentPosition);
    }

    // Update chain status
    if (nextSteps.isChainComplete) {
      this.registry.updateChain(chainId, { status: ChainStatus.COMPLETED });
      const updatedChain = this.registry.getChain(chainId);
      for (const notifier of this.notifiers) {
        try {
          await notifier.notifyChainCompleted(updatedChain);
        } catch {
          // ignore
        }
      }
      this.logger.info({ chainId }, 'Chain completed');
    } else if (nextSteps.isChainFailed) {
      this.registry.updateChain(chainId, { status: ChainStatus.FAILED });
      this.logger.warn({ chainId, reason: nextSteps.failureReason }, 'Chain failed');
    }
  }

  /** Get the job registry (for CLI commands) */
  getRegistry(): JobRegistry {
    return this.registry;
  }

  /** Get the executor (for log fetching, etc.) */
  getExecutor(): BaseExecutor {
    return this.executor;
  }

  /**
   * Tear down all components.
   */
  async destroy(): Promise<void> {
    await this.executor?.destroy();
    for (const notifier of this.notifiers) {
      try {
        await notifier.destroy();
      } catch {
        // ignore
      }
    }
    this.registry.close();
    this.eventBus.clear();
    this.logger.info('Orchestrator destroyed');
  }
}

// Backwards-compatible alias
export { AlchemyOrchestrator as Orchestrator };
