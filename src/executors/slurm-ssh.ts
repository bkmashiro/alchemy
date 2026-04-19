// src/executors/slurm-ssh.ts

import { NodeSSH } from 'node-ssh';
import pino from 'pino';
import { BaseExecutor, SubmitResult, StatusResult } from './base.js';
import {
  JobSpec,
  AlchemyJobId,
  SlurmJobId,
  JobStatus,
  SlurmSSHExecutorConfig,
  DEFAULT_RESOURCE_SPEC,
} from '../core/types.js';
import { SSHConnectionError, SubmissionError } from '../core/errors.js';
import { createLogger } from '../core/logger.js';
import { PluginManager } from '../core/plugin-manager.js';

// Reconnect backoff: start 1s, double each attempt, cap at 60s
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 60000;
const RECONNECT_MAX_ATTEMPTS = 8;

// Keepalive interval — ping jump host every 30s
const KEEPALIVE_INTERVAL_MS = 30000;

function backoffDelay(attempt: number): number {
  return Math.min(RECONNECT_BASE_DELAY_MS * 2 ** attempt, RECONNECT_MAX_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class SlurmSSHExecutor extends BaseExecutor {
  readonly type = 'slurm_ssh';
  private ssh1: NodeSSH; // local → jumpHost
  private ssh2: NodeSSH; // jumpHost → computeHost
  private jumpConnected = false;
  private reconnecting = false;
  private config: SlurmSSHExecutorConfig;
  private logger: pino.Logger;
  private webhookPublicUrl: string;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: SlurmSSHExecutorConfig, webhookPublicUrl = '') {
    super();
    this.config = config;
    this.webhookPublicUrl = webhookPublicUrl;
    this.ssh1 = new NodeSSH();
    this.ssh2 = new NodeSSH();
    this.logger = createLogger('SlurmSSH');
  }

  setWebhookPublicUrl(url: string): void {
    this.webhookPublicUrl = url;
  }

  async initialize(): Promise<void> {
    await this._connectAll();
    this._startKeepalive();
  }

  /**
   * Fully (re)connect both jump host and compute host, disposing old connections first.
   */
  private async _connectAll(): Promise<void> {
    this.jumpConnected = false;
    try { this.ssh2.dispose(); } catch { /* ignore */ }
    try { this.ssh1.dispose(); } catch { /* ignore */ }

    this.ssh1 = new NodeSSH();
    this.ssh2 = new NodeSSH();

    // Connect to jump host
    await this.ssh1.connect({
      host: this.config.jumpHost,
      username: this.config.user,
      agent: process.env['SSH_AUTH_SOCK'],
      privateKeyPath: this.config.privateKeyPath,
      readyTimeout: this.config.connectTimeout ?? 10000,
    });
    this.logger.info({ host: this.config.jumpHost }, 'Connected to jump host');

    // Null-safe access: verify connection object exists before tunnelling
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const jumpConn = (this.ssh1 as any).connection;
    if (!jumpConn) {
      throw new SSHConnectionError(
        'Jump host connection object is null after connect',
        this.config.jumpHost,
      );
    }

    // Tunnel through jump host to compute host
    const stream = await new Promise<NodeJS.ReadWriteStream>((resolve, reject) => {
      jumpConn.forwardOut(
        '127.0.0.1',
        0,
        this.config.computeHost,
        22,
        (err: Error | undefined, s: NodeJS.ReadWriteStream) => {
          if (err) {
            reject(
              new SSHConnectionError(
                `Failed to tunnel to ${this.config.computeHost}: ${err.message}`,
                this.config.computeHost,
              ),
            );
          } else {
            resolve(s);
          }
        },
      );
    });

    await this.ssh2.connect({
      sock: stream,
      username: this.config.user,
      agent: process.env['SSH_AUTH_SOCK'],
      privateKeyPath: this.config.privateKeyPath,
      readyTimeout: this.config.connectTimeout ?? 10000,
    });
    this.jumpConnected = true;
    this.logger.info({ host: this.config.computeHost }, 'Connected to compute host');
  }

  /**
   * Reconnect with exponential backoff. Concurrent callers wait for the same attempt.
   */
  private async _reconnect(): Promise<void> {
    if (this.reconnecting) {
      while (this.reconnecting) await sleep(200);
      return;
    }
    this.reconnecting = true;
    try {
      for (let attempt = 0; attempt < RECONNECT_MAX_ATTEMPTS; attempt++) {
        const delay = backoffDelay(attempt);
        if (attempt > 0) {
          this.logger.info(
            { attempt, delayMs: delay, host: this.config.jumpHost },
            'Waiting before SSH reconnect attempt',
          );
          await sleep(delay);
        }
        try {
          this.logger.info(
            { attempt: attempt + 1, max: RECONNECT_MAX_ATTEMPTS },
            'Reconnecting SSH tunnel',
          );
          await this._connectAll();
          this.logger.info({ host: this.config.computeHost }, 'SSH tunnel reconnected successfully');
          return;
        } catch (err) {
          this.logger.warn({ attempt: attempt + 1, err }, 'SSH reconnect attempt failed');
        }
      }
      throw new SSHConnectionError(
        `Failed to reconnect SSH tunnel after ${RECONNECT_MAX_ATTEMPTS} attempts`,
        this.config.computeHost,
      );
    } finally {
      this.reconnecting = false;
    }
  }

  /**
   * Periodic keepalive ping on the jump host to detect stale connections early.
   */
  private _startKeepalive(): void {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = setInterval(async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const conn = (this.ssh1 as any).connection;
        if (!conn) {
          this.logger.warn({ host: this.config.jumpHost }, 'Keepalive detected null jump connection, triggering reconnect');
          await this._reconnect();
          return;
        }
        await this.ssh1.execCommand('true');
      } catch (err) {
        this.logger.warn({ err, host: this.config.jumpHost }, 'Keepalive ping failed, triggering reconnect');
        this.jumpConnected = false;
        this._reconnect().catch(e =>
          this.logger.error({ err: e }, 'Background SSH reconnect failed'),
        );
      }
    }, KEEPALIVE_INTERVAL_MS);
    if (this.keepaliveTimer.unref) this.keepaliveTimer.unref();
  }

  /**
   * Generate the full sbatch script content.
   */
  private generateSbatchScript(alchemyJobId: AlchemyJobId, spec: JobSpec): string {
    const res = { ...DEFAULT_RESOURCE_SPEC, ...spec.resources };
    const logName = `${spec.name}_%j.log`;
    const logPath = `${this.config.logDir}/${logName}`;
    const envBin = spec.envBinPath ?? this.config.condaEnvBin;
    const workDir = spec.workingDir ?? this.config.projectRoot;
    const webhookUrl = this.webhookPublicUrl;

    // Build env vars section
    const envLines: string[] = [];
    const allEnv = { ...this.config.defaultEnv, ...res.env };
    for (const [key, value] of Object.entries(allEnv)) {
      envLines.push(`export ${key}='${value.replace(/'/g, "'\\''")}'`);
    }

    const extraDirectives = (res.extraDirectives ?? []).map((d) => `#SBATCH ${d}`).join('\n');
    const cpuDirective = res.cpusPerTask ? `#SBATCH --cpus-per-task=${res.cpusPerTask}` : '';

    const webhookSection = spec.disableWebhook
      ? ''
      : `
# ── Webhook notification function ──
_alchemy_notify() {
  local url="$1"
  local data="$2"
  python3 - "$url" "$data" << 'PYEOF'
import sys, json, urllib.request
url = sys.argv[1]
try:
    payload = json.dumps(json.loads(sys.argv[2])).encode()
    req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
    urllib.request.urlopen(req, timeout=10)
except Exception as e:
    print(f"[alchemy-notify] {e}", file=sys.stderr)
PYEOF
}

# ── EXIT trap: notify on completion/failure ──
trap '_alchemy_exit_code=$?
  _alchemy_elapsed=$SECONDS
  _alchemy_node=$(hostname | cut -d. -f1)
  [ $_alchemy_exit_code -eq 0 ] && _alchemy_status="completed" || _alchemy_status="failed"
  _alchemy_notify "${webhookUrl}/api/webhook/job-event" "{\\"jobId\\":\\"$SLURM_JOB_ID\\",\\"jobName\\":\\"${spec.name}\\",\\"status\\":\\"$_alchemy_status\\",\\"exitCode\\":$_alchemy_exit_code,\\"elapsed\\":$_alchemy_elapsed,\\"node\\":\\"$_alchemy_node\\",\\"alchemyJobId\\":\\"${alchemyJobId}\\"}"
' EXIT

# ── Notify start ──
_alchemy_notify "${webhookUrl}/api/webhook/job-event" "{\\"jobId\\":\\"$SLURM_JOB_ID\\",\\"jobName\\":\\"${spec.name}\\",\\"status\\":\\"started\\",\\"exitCode\\":0,\\"elapsed\\":0,\\"node\\":\\"$(hostname | cut -d. -f1)\\",\\"alchemyJobId\\":\\"${alchemyJobId}\\"}"
`;

    const script = `#!/bin/bash
#SBATCH --gres=gpu:${res.gpus}
#SBATCH --mem=${res.mem}
#SBATCH --time=${res.time}
#SBATCH --partition=${res.partition}
#SBATCH --job-name=${spec.name}
#SBATCH --output=${logPath}
${cpuDirective}
${extraDirectives}

set -e

# ── Environment ──
export PATH="${envBin}:$PATH"
export TORCH_HOME='/vol/bitbucket/${this.config.user}/.cache/torch'
export XDG_CACHE_HOME='/vol/bitbucket/${this.config.user}/.cache'
export ALCHEMY_JOB_ID='${alchemyJobId}'
${envLines.join('\n')}
${webhookSection}
cd ${workDir}

# ── Job info banner ──
echo "=== Alchemy Job: ${spec.name} | Slurm ID: \${SLURM_JOB_ID} | Node: $(hostname) | $(date) ==="
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null || true
echo ""

# ── Run command ──
echo "Running: ${spec.command}"
${spec.command}
`;

    return script;
  }

  async submit(alchemyJobId: AlchemyJobId, spec: JobSpec): Promise<SubmitResult> {
    const scriptContent = this.generateSbatchScript(alchemyJobId, spec);

    // Write temp script to remote filesystem
    const tmpPath = `${this.config.projectRoot}/.alchemy_tmp_${Date.now()}_${alchemyJobId.slice(0, 8)}.sh`;

    // Use printf to avoid heredoc issues with special characters
    const writeCmd = `printf '%s' ${JSON.stringify(scriptContent)} > '${tmpPath}' && chmod +x '${tmpPath}'`;
    await this.execRemote(writeCmd);

    try {
      // Submit via sbatch
      const result = await this.execRemote(`sbatch '${tmpPath}'`);

      // sbatch output: "Submitted batch job 12345678"
      const match = result.stdout.match(/Submitted batch job (\d+)/);
      if (!match?.[1]) {
        throw new SubmissionError(
          `Failed to parse job ID from sbatch output: ${result.stdout}`,
          result.stderr,
        );
      }

      const slurmJobId = match[1];
      const logPath = `${this.config.logDir}/${spec.name}_${slurmJobId}.log`;

      this.logger.info({ slurmJobId, alchemyJobId, jobName: spec.name }, 'Job submitted');

      return { externalJobId: slurmJobId, logPath };
    } finally {
      // Clean up temp script
      await this.execRemote(`rm -f '${tmpPath}'`).catch(() => {});
    }
  }

  async status(slurmJobId: SlurmJobId): Promise<StatusResult> {
    // Use sacct for completed jobs, squeue for running/pending
    const { stdout } = await this.execRemote(
      `sacct -j ${slurmJobId} --format=State,ExitCode,Elapsed,NodeList --noheader --parsable2 | head -1`,
    );

    if (!stdout.trim()) {
      // Fallback: try squeue
      const sq = await this.execRemote(
        `squeue -j ${slurmJobId} --format="%T|%N|%M" --noheader`,
      );
      if (!sq.stdout.trim()) {
        return { status: JobStatus.UNKNOWN };
      }
      const parts = sq.stdout.trim().split('|');
      return {
        status: this.mapSlurmState(parts[0] ?? ''),
        node: parts[1] || undefined,
        elapsed: this.parseElapsed(parts[2] ?? ''),
      };
    }

    const parts = stdout.trim().split('|');
    const exitCode = parseInt((parts[1] ?? '0').split(':')[0] ?? '0', 10);

    return {
      status: this.mapSlurmState(parts[0] ?? ''),
      exitCode,
      node: parts[3] || undefined,
      elapsed: this.parseElapsed(parts[2] ?? ''),
    };
  }

  /**
   * Map Slurm state strings to JobStatus enum.
   */
  private mapSlurmState(state: string): JobStatus {
    const s = state.trim().toUpperCase();
    const map: Record<string, JobStatus> = {
      PENDING: JobStatus.PENDING,
      RUNNING: JobStatus.RUNNING,
      COMPLETED: JobStatus.COMPLETED,
      FAILED: JobStatus.FAILED,
      CANCELLED: JobStatus.CANCELLED,
      'CANCELLED+': JobStatus.CANCELLED,
      TIMEOUT: JobStatus.TIMEOUT,
      NODE_FAIL: JobStatus.FAILED,
      PREEMPTED: JobStatus.FAILED,
      OUT_OF_MEMORY: JobStatus.FAILED,
    };
    return map[s] ?? JobStatus.UNKNOWN;
  }

  /**
   * Parse Slurm elapsed time format (HH:MM:SS or D-HH:MM:SS) to seconds.
   */
  private parseElapsed(elapsed: string): number | undefined {
    if (!elapsed) return undefined;
    // Handle D-HH:MM:SS format
    const dayMatch = elapsed.match(/^(\d+)-(\d+):(\d+):(\d+)$/);
    if (dayMatch) {
      return (
        parseInt(dayMatch[1]!, 10) * 86400 +
        parseInt(dayMatch[2]!, 10) * 3600 +
        parseInt(dayMatch[3]!, 10) * 60 +
        parseInt(dayMatch[4]!, 10)
      );
    }
    // Handle HH:MM:SS format
    const parts = elapsed.split(':');
    if (parts.length === 3) {
      return (
        parseInt(parts[0]!, 10) * 3600 +
        parseInt(parts[1]!, 10) * 60 +
        parseInt(parts[2]!, 10)
      );
    }
    return undefined;
  }

  async cancel(slurmJobId: SlurmJobId): Promise<void> {
    const { stderr } = await this.execRemote(`scancel ${slurmJobId}`);
    if (stderr.trim()) {
      this.logger.warn({ slurmJobId, stderr }, 'scancel warning');
    }
  }

  async fetchLogs(logPath: string, tailLines = 50): Promise<string> {
    const { stdout } = await this.execRemote(`tail -n ${tailLines} '${logPath}' 2>/dev/null`);
    return stdout;
  }

  async destroy(): Promise<void> {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    this.ssh2.dispose();
    this.ssh1.dispose();
    this.jumpConnected = false;
    this.logger.info('SSH connections closed');
  }

  /**
   * Execute a command on the compute host (ssh2).
   * On failure, triggers a full tunnel reconnect with exponential backoff,
   * then retries the command once.
   */
  private async execRemote(
    command: string,
  ): Promise<{ stdout: string; stderr: string }> {
    const attempt = async () => {
      const result = await this.ssh2.execCommand(command, {
        cwd: this.config.projectRoot,
      });
      if (result.code !== 0 && result.code !== null) {
        this.logger.warn(
          { command: command.slice(0, 100), stderr: result.stderr, code: result.code },
          'Remote command non-zero exit',
        );
      }
      return { stdout: result.stdout, stderr: result.stderr };
    };

    try {
      return await attempt();
    } catch (err) {
      this.logger.warn({ err }, 'SSH command failed, attempting reconnect with backoff');
      this.jumpConnected = false;
      try {
        await this._reconnect();
        return await attempt();
      } catch (reconnectErr) {
        throw new SSHConnectionError(
          `SSH command failed after reconnect: ${String(reconnectErr)}`,
          this.config.computeHost,
        );
      }
    }
  }
}

// Self-registration
PluginManager.instance.registerExecutor(
  'slurm_ssh',
  (config) => new SlurmSSHExecutor(config as SlurmSSHExecutorConfig),
);
