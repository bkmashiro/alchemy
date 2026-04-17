// src/executors/local.ts

import { spawn, ChildProcess } from 'node:child_process';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { BaseExecutor, SubmitResult, StatusResult } from './base.js';
import {
  JobSpec,
  AlchemyJobId,
  SlurmJobId,
  JobStatus,
  LocalExecutorConfig,
} from '../core/types.js';
import { PluginManager } from '../core/plugin-manager.js';
import { createLogger } from '../core/logger.js';

interface ProcessEntry {
  proc: ChildProcess;
  startTime: number;
  exitCode: number | null;
  logPath: string;
}

export class LocalExecutor extends BaseExecutor {
  readonly type = 'local';
  private config: LocalExecutorConfig;
  private processes: Map<string, ProcessEntry> = new Map();
  private logger = createLogger('LocalExecutor');

  constructor(config: LocalExecutorConfig) {
    super();
    this.config = config;
  }

  async initialize(): Promise<void> {
    await mkdir(this.config.logDir, { recursive: true });
    await mkdir(this.config.workingDir, { recursive: true });
    this.logger.info({ logDir: this.config.logDir }, 'LocalExecutor initialized');
  }

  async submit(alchemyJobId: AlchemyJobId, spec: JobSpec): Promise<SubmitResult> {
    // Generate a fake slurm ID (random 8-digit number)
    const fakeJobId = Math.floor(10000000 + Math.random() * 90000000).toString();
    const logPath = `${this.config.logDir}/${spec.name}_${fakeJobId}.log`;

    const logStream = createWriteStream(logPath, { flags: 'a' });

    const proc = spawn('bash', ['-c', spec.command], {
      cwd: spec.workingDir ?? this.config.workingDir,
      env: {
        ...process.env,
        ALCHEMY_JOB_ID: alchemyJobId,
        SLURM_JOB_ID: fakeJobId,
        SLURM_JOB_NAME: spec.name,
        ...spec.resources.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.stdout?.pipe(logStream);
    proc.stderr?.pipe(logStream);

    const entry: ProcessEntry = {
      proc,
      startTime: Date.now(),
      exitCode: null,
      logPath,
    };

    this.processes.set(fakeJobId, entry);

    proc.on('exit', (code) => {
      const e = this.processes.get(fakeJobId);
      if (e) e.exitCode = code ?? 1;
      logStream.end();
    });

    this.logger.info({ fakeJobId, jobName: spec.name, alchemyJobId }, 'Local job spawned');

    return { externalJobId: fakeJobId, logPath };
  }

  async status(externalJobId: SlurmJobId): Promise<StatusResult> {
    const entry = this.processes.get(externalJobId);
    if (!entry) {
      return { status: JobStatus.UNKNOWN };
    }

    if (entry.exitCode === null) {
      const elapsed = Math.floor((Date.now() - entry.startTime) / 1000);
      return { status: JobStatus.RUNNING, elapsed };
    }

    const elapsed = Math.floor((Date.now() - entry.startTime) / 1000);
    return {
      status: entry.exitCode === 0 ? JobStatus.COMPLETED : JobStatus.FAILED,
      exitCode: entry.exitCode,
      elapsed,
    };
  }

  async cancel(externalJobId: SlurmJobId): Promise<void> {
    const entry = this.processes.get(externalJobId);
    if (!entry || entry.exitCode !== null) return;

    entry.proc.kill('SIGTERM');

    // SIGKILL after 5s if still running
    setTimeout(() => {
      if (entry.exitCode === null) {
        entry.proc.kill('SIGKILL');
      }
    }, 5000);
  }

  async fetchLogs(logPath: string, tailLines = 50): Promise<string> {
    try {
      const content = await readFile(logPath, 'utf-8');
      const lines = content.split('\n');
      return lines.slice(-tailLines).join('\n');
    } catch {
      return '';
    }
  }

  async destroy(): Promise<void> {
    for (const [id, entry] of this.processes) {
      if (entry.exitCode === null) {
        entry.proc.kill('SIGTERM');
        this.logger.info({ jobId: id }, 'Killed local job on destroy');
      }
    }
    this.processes.clear();
  }
}

// Self-registration
PluginManager.instance.registerExecutor(
  'local',
  (config) => new LocalExecutor(config as LocalExecutorConfig),
);
