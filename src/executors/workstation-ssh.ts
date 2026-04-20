// src/executors/workstation-ssh.ts

import { NodeSSH } from 'node-ssh';
import pino from 'pino';
import { BaseExecutor, SubmitResult, StatusResult } from './base.js';
import {
  JobSpec,
  AlchemyJobId,
  JobStatus,
  WorkstationSSHExecutorConfig,
  WorkstationHost,
  GpuStatus,
} from '../core/types.js';
import { SSHConnectionError, SubmissionError } from '../core/errors.js';
import { createLogger } from '../core/logger.js';
import { PluginManager } from '../core/plugin-manager.js';

export interface GPUQueryResult {
  host: WorkstationHost;
  memoryUsedMB: number;
  memoryTotalMB: number;
  memoryFreeMB: number;
  gpuUtil: number;
  hasForeignProcess: boolean;
  available: boolean;
}

/**
 * Executor for bare Linux workstations (no SLURM) via SSH + nohup.
 * Jobs are tracked by PID files on the remote machine.
 * External job ID format: "ws:<hostname>:<pid>"
 */
// Reconnect backoff: start 1s, double each attempt, cap at 60s
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 60000;
const RECONNECT_MAX_ATTEMPTS = 8;

// Keepalive interval — ping jump host every 30s to detect stale connections early
const KEEPALIVE_INTERVAL_MS = 30000;

// GPU status cache — tiered TTL per host
const GPU_TTL_ACTIVE_MS  = 3  * 60_000;  // hosts with running jobs: 3 min
const GPU_TTL_IDLE_MS    = 10 * 60_000;  // cold hosts (no tasks): 10 min
const GPU_TTL_FULL_MS    = 10 * 60_000;  // saturated hosts (util>90%): 10 min
const GPU_TTL_STALE_MS   = 10 * 60_000;  // force refresh threshold for initial load

function backoffDelay(attempt: number): number {
  return Math.min(RECONNECT_BASE_DELAY_MS * 2 ** attempt, RECONNECT_MAX_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class WorkstationSSHExecutor extends BaseExecutor {
  readonly type = 'workstation_ssh';
  private jumpSSH: NodeSSH;
  private jumpConnected = false;
  private jumpReconnecting = false;
  private hostConnections: Map<string, NodeSSH> = new Map();
  private config: WorkstationSSHExecutorConfig;
  private logger: pino.Logger;
  private webhookPublicUrl: string;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  /** Per-host GPU status cache: hostname → { status, queriedAt } */
  private gpuCache: Map<string, { status: GpuStatus; queriedAt: number }> = new Map();
  /** Hosts with running alchemy jobs — updated by status() calls */
  private activeHosts: Set<string> = new Set();

  constructor(config: WorkstationSSHExecutorConfig, webhookPublicUrl = '') {
    super();
    this.config = config;
    this.webhookPublicUrl = webhookPublicUrl;
    this.jumpSSH = new NodeSSH();
    this.logger = createLogger('WorkstationSSH');
  }

  setWebhookPublicUrl(url: string): void {
    this.webhookPublicUrl = url;
  }

  async initialize(): Promise<void> {
    await this._connectJump();
    this._startKeepalive();
  }

  /**
   * Connect (or reconnect) the jump host SSH connection.
   * Disposes stale host connections on reconnect since tunnels are invalidated.
   */
  private async _connectJump(): Promise<void> {
    // Dispose existing jump connection and all tunneled host connections
    try { this.jumpSSH.dispose(); } catch { /* ignore */ }
    for (const [name, ssh] of this.hostConnections) {
      try { ssh.dispose(); } catch { /* ignore */ }
      this.logger.debug({ host: name }, 'Dropped tunneled host connection (jump reconnect)');
    }
    this.hostConnections.clear();
    this.jumpConnected = false;

    this.jumpSSH = new NodeSSH();
    await this.jumpSSH.connect({
      host: this.config.jumpHost,
      username: this.config.user,
      agent: process.env['SSH_AUTH_SOCK'],
      privateKeyPath: this.config.privateKeyPath,
      readyTimeout: this.config.connectTimeout ?? 10000,
    });
    this.jumpConnected = true;
    this.logger.info({ host: this.config.jumpHost }, 'Connected to jump host');
  }

  /**
   * Ensure the jump host connection is alive, reconnecting with exponential
   * backoff if it has dropped. Concurrent callers wait for the same attempt.
   */
  private async _ensureJumpConnected(): Promise<void> {
    // Fast path: already connected
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (this.jumpConnected && (this.jumpSSH as any).connection !== null) return;

    if (this.jumpReconnecting) {
      // Wait until the ongoing reconnect resolves (poll cheaply)
      while (this.jumpReconnecting) await sleep(200);
      return;
    }

    this.jumpReconnecting = true;
    try {
      for (let attempt = 0; attempt < RECONNECT_MAX_ATTEMPTS; attempt++) {
        const delay = backoffDelay(attempt);
        if (attempt > 0) {
          this.logger.info(
            { attempt, delayMs: delay, host: this.config.jumpHost },
            'Waiting before jump host reconnect attempt',
          );
          await sleep(delay);
        }
        try {
          this.logger.info(
            { attempt: attempt + 1, max: RECONNECT_MAX_ATTEMPTS, host: this.config.jumpHost },
            'Reconnecting to jump host',
          );
          await this._connectJump();
          this.logger.info({ host: this.config.jumpHost }, 'Jump host reconnected successfully');
          return;
        } catch (err) {
          this.logger.warn(
            { attempt: attempt + 1, err, host: this.config.jumpHost },
            'Jump host reconnect attempt failed',
          );
        }
      }
      throw new SSHConnectionError(
        `Failed to reconnect to jump host after ${RECONNECT_MAX_ATTEMPTS} attempts`,
        this.config.jumpHost,
      );
    } finally {
      this.jumpReconnecting = false;
    }
  }

  /**
   * Periodic keepalive: runs a no-op on the jump host to detect stale
   * connections before the next real command hits them.
   */
  private _startKeepalive(): void {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = setInterval(async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const conn = (this.jumpSSH as any).connection;
        if (!conn) {
          this.logger.warn({ host: this.config.jumpHost }, 'Keepalive detected null jump connection, triggering reconnect');
          await this._ensureJumpConnected();
          return;
        }
        await this.jumpSSH.execCommand('true');
      } catch (err) {
        this.logger.warn({ err, host: this.config.jumpHost }, 'Keepalive ping failed, marking jump connection stale');
        this.jumpConnected = false;
        // Proactively reconnect so next real command doesn't pay the full delay
        this._ensureJumpConnected().catch(e =>
          this.logger.error({ err: e }, 'Background jump reconnect failed'),
        );
      }
    }, KEEPALIVE_INTERVAL_MS);
    // Don't block process exit on this timer
    if (this.keepaliveTimer.unref) this.keepaliveTimer.unref();
  }

  /**
   * Get or create an SSH connection to a specific workstation host,
   * tunneled through the jump host.
   */
  private async getHostConnection(hostname: string): Promise<NodeSSH> {
    const existing = this.hostConnections.get(hostname);
    if (existing && existing.isConnected()) {
      return existing;
    }

    const host = this.config.hosts.find(h => h.hostname === hostname || h.name === hostname);
    if (!host) {
      throw new SSHConnectionError(`Unknown host: ${hostname}`, hostname);
    }

    // Guarantee the jump host is up before trying to tunnel through it
    await this._ensureJumpConnected();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const jumpConn = (this.jumpSSH as any).connection;
    if (!jumpConn) {
      throw new SSHConnectionError(
        `Jump host connection is null after reconnect attempt`,
        this.config.jumpHost,
      );
    }

    const stream = await new Promise<NodeJS.ReadWriteStream>((resolve, reject) => {
      jumpConn.forwardOut(
        '127.0.0.1',
        0,
        host.hostname,
        22,
        (err: Error | undefined, s: NodeJS.ReadWriteStream) => {
          if (err) {
            reject(
              new SSHConnectionError(
                `Failed to tunnel to ${host.hostname}: ${err.message}`,
                host.hostname,
              ),
            );
          } else {
            resolve(s);
          }
        },
      );
    });

    const ssh = new NodeSSH();
    await ssh.connect({
      sock: stream,
      username: this.config.user,
      agent: process.env['SSH_AUTH_SOCK'],
      privateKeyPath: this.config.privateKeyPath,
      readyTimeout: this.config.connectTimeout ?? 10000,
    });

    this.hostConnections.set(hostname, ssh);
    this.logger.info({ host: hostname }, 'Connected to workstation host');
    return ssh;
  }

  /**
   * Execute a command on a specific workstation host.
   * On failure, drops the cached host connection and the jump connection (if
   * it looks stale) then retries with full exponential-backoff reconnect.
   */
  private async execOnHost(
    hostname: string,
    command: string,
  ): Promise<{ stdout: string; stderr: string }> {
    const attempt = async () => {
      const ssh = await this.getHostConnection(hostname);
      const result = await ssh.execCommand(command, {
        cwd: this.config.projectRoot,
      });
      if (result.code !== 0 && result.code !== null) {
        this.logger.warn(
          { command: command.slice(0, 100), stderr: result.stderr, code: result.code, host: hostname },
          'Remote command non-zero exit',
        );
      }
      return { stdout: result.stdout, stderr: result.stderr };
    };

    try {
      return await attempt();
    } catch (err) {
      // Drop cached host connection; if the error looks like a jump-level
      // failure (null connection / forwardOut), also mark jump as stale.
      this.hostConnections.delete(hostname);
      const msg = String((err as Error)?.message ?? err);
      if (msg.includes('forwardOut') || msg.includes('null') || msg.includes('No response from server')) {
        this.logger.warn({ err, host: hostname }, 'Jump host connection appears stale, will reconnect');
        this.jumpConnected = false;
      } else {
        this.logger.warn({ err, host: hostname }, 'SSH command failed, attempting reconnect');
      }

      try {
        return await attempt();
      } catch (reconnectErr) {
        throw new SSHConnectionError(
          `SSH command failed after reconnect: ${String(reconnectErr)}`,
          hostname,
        );
      }
    }
  }

  /**
   * Resolve a host name or "auto" to a concrete WorkstationHost.
   * "auto" picks the best available host: enough free VRAM, lowest GPU utilization,
   * no heavy foreign GPU processes.
   */
  private async resolveHost(targetHost?: string, vramRequiredGB?: number): Promise<WorkstationHost> {
    if (targetHost && targetHost !== 'auto') {
      const host = this.config.hosts.find(h => h.name === targetHost || h.hostname === targetHost);
      if (!host) {
        throw new SubmissionError(`Unknown workstation host: ${targetHost}`, '');
      }
      return host;
    }

    const results = await this.listAvailableHosts();
    let candidates = results.filter(r => r.available && !r.hasForeignProcess);

    if (vramRequiredGB !== undefined) {
      const requiredMB = vramRequiredGB * 1024;
      candidates = candidates.filter(r => r.memoryFreeMB >= requiredMB);
    }

    if (candidates.length === 0) {
      // Fallback: ignore foreign process check, just need free VRAM
      const fallback = results.filter(r => r.available);
      if (vramRequiredGB !== undefined) {
        const requiredMB = vramRequiredGB * 1024;
        const withVram = fallback.filter(r => r.memoryFreeMB >= requiredMB);
        if (withVram.length > 0) {
          withVram.sort((a, b) => a.gpuUtil - b.gpuUtil);
          return withVram[0]!.host;
        }
      }
      if (fallback.length === 0) {
        throw new SubmissionError('No workstation hosts with available GPU memory', '');
      }
      fallback.sort((a, b) => b.memoryFreeMB - a.memoryFreeMB);
      return fallback[0]!.host;
    }

    // Sort by GPU utilization ascending (least loaded first)
    candidates.sort((a, b) => a.gpuUtil - b.gpuUtil);
    return candidates[0]!.host;
  }

  /**
   * Generate the wrapper script to run with nohup.
   */
  private generateWrapperScript(alchemyJobId: AlchemyJobId, spec: JobSpec, logPath: string): string {
    const envBin = spec.envBinPath ?? this.config.condaEnvBin;
    const workDir = spec.workingDir ?? this.config.projectRoot;
    const webhookUrl = this.webhookPublicUrl;

    const envLines: string[] = [];
    const allEnv = { ...this.config.defaultEnv, ...spec.resources?.env };
    for (const [key, value] of Object.entries(allEnv)) {
      envLines.push(`export ${key}='${value.replace(/'/g, "'\\''")}'`);
    }

    const webhookSection = spec.disableWebhook || !webhookUrl
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
  _alchemy_notify "${webhookUrl}/api/webhook/job-event" "{\\"jobId\\":\\"ws:$(hostname | cut -d. -f1):$$\\",\\"jobName\\":\\"${spec.name}\\",\\"status\\":\\"$_alchemy_status\\",\\"exitCode\\":$_alchemy_exit_code,\\"elapsed\\":$_alchemy_elapsed,\\"node\\":\\"$_alchemy_node\\",\\"alchemyJobId\\":\\"${alchemyJobId}\\"}"
' EXIT

# ── Notify start ──
_alchemy_notify "${webhookUrl}/api/webhook/job-event" "{\\"jobId\\":\\"ws:$(hostname | cut -d. -f1):$$\\",\\"jobName\\":\\"${spec.name}\\",\\"status\\":\\"started\\",\\"exitCode\\":0,\\"elapsed\\":0,\\"node\\":\\"$(hostname | cut -d. -f1)\\",\\"alchemyJobId\\":\\"${alchemyJobId}\\"}"
`;

    return `#!/bin/bash
set -e

# ── Environment ──
export PATH="${envBin}:$PATH"
export ALCHEMY_JOB_ID='${alchemyJobId}'
${envLines.join('\n')}
${webhookSection}
cd ${workDir}

# ── Job info banner ──
echo "=== Alchemy Workstation Job: ${spec.name} | PID: $$ | Host: $(hostname) | $(date) ==="
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null || true
echo ""

# ── Run command ──
echo "Running: ${spec.command}"
${spec.command}
`;
  }

  /**
   * Parse the external job ID format "ws:<hostname>:<pid>".
   */
  private parseExternalJobId(externalJobId: string): { hostname: string; pid: string } {
    const parts = externalJobId.split(':');
    if (parts.length !== 3 || parts[0] !== 'ws') {
      throw new Error(`Invalid workstation job ID format: ${externalJobId} (expected ws:<host>:<pid>)`);
    }
    return { hostname: parts[1]!, pid: parts[2]! };
  }

  async submit(alchemyJobId: AlchemyJobId, spec: JobSpec): Promise<SubmitResult> {
    // Determine target host from spec metadata or auto-select
    const targetHostName = (spec.metadata?.['targetHost'] as string) ?? 'auto';
    const host = await this.resolveHost(targetHostName, spec.vram);
    const hostname = host.name;

    const logDir = `${this.config.projectRoot}/logs`;
    const logPath = `${logDir}/ws_${spec.name}_${alchemyJobId}.log`;
    const pidPath = `${logDir}/.ws_${alchemyJobId}.pid`;

    // Ensure log directory exists
    await this.execOnHost(hostname, `mkdir -p '${logDir}'`);

    // Check checkpoint if configured
    if (spec.checkpoint?.skipIfExists && spec.checkpoint.path) {
      const checkPath = spec.checkpoint.path.replace(/\$\{name\}/g, spec.name);
      const { stdout } = await this.execOnHost(hostname, `test -f '${checkPath}' && echo EXISTS || echo MISSING`);
      if (stdout.trim() === 'EXISTS') {
        this.logger.info({ alchemyJobId, checkpoint: checkPath, host: hostname }, 'Checkpoint exists, skipping');
        return { externalJobId: `ws:${hostname}:skipped`, logPath };
      }
    }

    // Generate and write wrapper script
    const scriptContent = this.generateWrapperScript(alchemyJobId, spec, logPath);
    const scriptPath = `${logDir}/.ws_${alchemyJobId}.sh`;

    const b64 = Buffer.from(scriptContent, 'utf-8').toString('base64');
    const writeCmd = `echo '${b64}' | base64 -d > '${scriptPath}' && chmod +x '${scriptPath}'`;
    await this.execOnHost(hostname, writeCmd);

    try {
      // Launch with nohup, capture PID
      const launchCmd = `nohup bash '${scriptPath}' > '${logPath}' 2>&1 & echo $!`;
      const { stdout } = await this.execOnHost(hostname, launchCmd);
      const pid = stdout.trim();

      if (!pid || !/^\d+$/.test(pid)) {
        throw new SubmissionError(
          `Failed to capture PID from nohup output: "${stdout}"`,
          '',
        );
      }

      // Write PID file and start timestamp
      await this.execOnHost(hostname, `echo '${pid}' > '${pidPath}' && date +%s > '${pidPath}.start'`);

      const externalJobId = `ws:${hostname}:${pid}`;
      this.logger.info({ externalJobId, alchemyJobId, jobName: spec.name, host: hostname }, 'Job submitted');

      return { externalJobId, logPath };
    } catch (err) {
      // Clean up script on failure
      await this.execOnHost(hostname, `rm -f '${scriptPath}'`).catch(() => {});
      throw err;
    }
  }

  async status(externalJobId: string): Promise<StatusResult> {
    // Handle skipped jobs
    if (externalJobId.endsWith(':skipped')) {
      return { status: JobStatus.COMPLETED, exitCode: 0 };
    }

    const { hostname, pid } = this.parseExternalJobId(externalJobId);

    const logDir = `${this.config.projectRoot}/logs`;

    try {
      // Check process + read start timestamp in one SSH call
      const { stdout } = await this.execOnHost(
        hostname,
        `kill -0 ${pid} 2>/dev/null && echo RUNNING || echo STOPPED; for f in ${logDir}/.ws_*.pid; do [ "$(cat "$f" 2>/dev/null)" = "${pid}" ] && cat "$f.start" 2>/dev/null && break; done; date +%s`,
      );

      const lines = stdout.trim().split('\n');
      const state = lines[0];
      const startTs = parseInt(lines[1] ?? '', 10);
      const nowTs = parseInt(lines[2] ?? '', 10);
      const elapsed = (!isNaN(startTs) && !isNaN(nowTs)) ? nowTs - startTs : undefined;

      // Track active hosts for tiered cache TTL
      if (state === 'RUNNING') {
        this.activeHosts.add(hostname);
        // Piggyback: refresh GPU cache for active host in background
        this.updateHostGpuCache(hostname).catch(() => {});
        return { status: JobStatus.RUNNING, node: hostname, elapsed };
      }

      this.activeHosts.delete(hostname);
      return { status: JobStatus.COMPLETED, node: hostname, elapsed };
    } catch {
      return { status: JobStatus.UNKNOWN, node: hostname };
    }
  }

  async cancel(externalJobId: string): Promise<void> {
    if (externalJobId.endsWith(':skipped')) return;

    const { hostname, pid } = this.parseExternalJobId(externalJobId);
    const { stderr } = await this.execOnHost(hostname, `kill ${pid} 2>&1 || true`);
    if (stderr.trim()) {
      this.logger.warn({ externalJobId, stderr }, 'kill warning');
    }
  }

  async fetchLogs(logPath: string, tailLines = 50): Promise<string> {
    // Extract hostname from log path context — try all hosts
    // The log path alone doesn't tell us which host, so we need the caller to provide context
    // For now, try to find the log on any connected host
    for (const host of this.config.hosts) {
      try {
        const { stdout } = await this.execOnHost(host.name, `tail -c 200000 '${logPath}' 2>/dev/null | tr '\\r' '\\n' | tail -n ${tailLines}`);
        if (stdout) return stdout;
      } catch {
        continue;
      }
    }
    return '';
  }

  /**
   * Fetch logs for a specific host (used when we know the host from externalJobId).
   */
  async fetchLogsFromHost(hostname: string, logPath: string, tailLines = 50): Promise<string> {
    const { stdout } = await this.execOnHost(
      hostname,
      `tail -c 200000 '${logPath}' 2>/dev/null | tr '\\r' '\\n' | tail -n ${tailLines}`,
    );
    return stdout;
  }

  /**
   * Query GPU usage on a specific host via nvidia-smi.
   * Returns memory and utilization per GPU.
   */
  async queryGPU(hostname: string): Promise<{ usedMB: number; totalMB: number; util: number }[]> {
    const { stdout } = await this.execOnHost(
      hostname,
      'nvidia-smi --query-gpu=memory.used,memory.total,utilization.gpu --format=csv,noheader,nounits',
    );

    const gpus: { usedMB: number; totalMB: number; util: number }[] = [];
    for (const line of stdout.trim().split('\n')) {
      const parts = line.split(',').map(s => s.trim());
      if (parts.length >= 2) {
        gpus.push({
          usedMB: parseInt(parts[0]!, 10),
          totalMB: parseInt(parts[1]!, 10),
          util: parts[2] ? parseInt(parts[2], 10) : 0,
        });
      }
    }
    return gpus;
  }

  /**
   * Check whether any GPU process on the host belongs to another user.
   * Uses nvidia-smi pmon to list PIDs, then maps them to usernames.
   */
  private async hasForeignGpuProcess(hostname: string): Promise<boolean> {
    try {
      // Get PIDs of GPU processes, then check their owner
      const { stdout } = await this.execOnHost(
        hostname,
        `nvidia-smi pmon -c 1 -s m 2>/dev/null | awk 'NR>2 && $2~/^[0-9]+$/ {print $2}' | xargs -r ps -o user= -p 2>/dev/null | grep -v '^${this.config.user}$' | head -1`,
      );
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Query all configured hosts concurrently and return availability info.
   * Each host query has a 8s timeout to avoid blocking on unreachable machines.
   */
  async listAvailableHosts(): Promise<GPUQueryResult[]> {
    const queryOne = async (host: WorkstationHost): Promise<GPUQueryResult> => {
      try {
        const [gpus, foreignProcess] = await Promise.race([
          Promise.all([
            this.queryGPU(host.name),
            this.hasForeignGpuProcess(host.name),
          ]),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('GPU query timeout')), 8000),
          ),
        ]);
        const totalUsed = gpus.reduce((sum, g) => sum + g.usedMB, 0);
        const totalMem = gpus.reduce((sum, g) => sum + g.totalMB, 0);
        const freeMB = totalMem - totalUsed;
        const avgUtil = gpus.length > 0
          ? gpus.reduce((sum, g) => sum + g.util, 0) / gpus.length
          : 0;
        return {
          host,
          memoryUsedMB: totalUsed,
          memoryTotalMB: totalMem,
          memoryFreeMB: freeMB,
          gpuUtil: avgUtil,
          hasForeignProcess: foreignProcess,
          available: freeMB > 2048,
        };
      } catch (err) {
        this.logger.warn({ host: host.name, err }, 'Failed to query GPU');
        return {
          host,
          memoryUsedMB: 0,
          memoryTotalMB: 0,
          memoryFreeMB: 0,
          gpuUtil: 0,
          hasForeignProcess: false,
          available: false,
        };
      }
    };

    return Promise.all(this.config.hosts.map(queryOne));
  }

  /**
   * Determine the cache TTL for a host based on its state.
   * Active (running alchemy jobs) → 3 min, saturated (>90% util) → 10 min, idle → 10 min.
   */
  private hostTTL(hostname: string): number {
    if (this.activeHosts.has(hostname)) return GPU_TTL_ACTIVE_MS;
    const cached = this.gpuCache.get(hostname);
    if (cached && cached.status.gpuUtil > 90) return GPU_TTL_FULL_MS;
    return GPU_TTL_IDLE_MS;
  }

  /**
   * Return GpuStatus objects for all hosts (for dashboard API).
   *
   * Strategy: always return cached data immediately. For hosts whose cache
   * has expired, refresh them in the background. On first call (empty cache)
   * or if any host is older than GPU_TTL_STALE_MS, do a synchronous refresh
   * of those stale hosts only.
   */
  async getGpuStatus(): Promise<GpuStatus[]> {
    const now = Date.now();
    const staleHosts: WorkstationHost[] = [];
    const freshResults: GpuStatus[] = [];

    for (const host of this.config.hosts) {
      const cached = this.gpuCache.get(host.name);
      if (cached) {
        freshResults.push(cached.status);
        const ttl = this.hostTTL(host.name);
        if (now - cached.queriedAt > ttl) {
          staleHosts.push(host);
        }
      } else {
        // No cache at all — must query synchronously
        staleHosts.push(host);
      }
    }

    if (staleHosts.length > 0) {
      // Query only stale hosts, in parallel
      const refreshed = await Promise.all(staleHosts.map(h => this._queryOneHost(h)));
      for (const entry of refreshed) {
        this.gpuCache.set(entry.host, { status: entry, queriedAt: now });
        const idx = freshResults.findIndex(s => s.host === entry.host);
        if (idx >= 0) freshResults[idx] = entry;
        else freshResults.push(entry);
      }
    }

    return freshResults;
  }

  /**
   * Query a single host and return a GpuStatus. On failure returns unreachable entry.
   */
  private async _queryOneHost(host: WorkstationHost): Promise<GpuStatus> {
    try {
      const [gpus, foreignProcess] = await Promise.race([
        Promise.all([this.queryGPU(host.name), this.hasForeignGpuProcess(host.name)]),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('GPU query timeout')), 8000)),
      ]);
      const totalUsed = gpus.reduce((s, g) => s + g.usedMB, 0);
      const totalMem = gpus.reduce((s, g) => s + g.totalMB, 0);
      const freeMB = totalMem - totalUsed;
      const avgUtil = gpus.length > 0 ? gpus.reduce((s, g) => s + g.util, 0) / gpus.length : 0;
      return {
        host: host.name,
        gpuType: host.gpuType,
        totalVram: host.vram,
        usedVram: Math.round(totalUsed / 1024 * 10) / 10,
        freeVram: Math.round(freeMB / 1024 * 10) / 10,
        gpuUtil: Math.round(avgUtil),
        hasForeignProcess: foreignProcess,
        available: freeMB > 2048,
        reachable: totalMem > 0,
        lastQueried: Date.now(),
      };
    } catch (err) {
      this.logger.warn({ host: host.name, err }, 'Failed to query GPU');
      return {
        host: host.name,
        gpuType: host.gpuType,
        totalVram: host.vram,
        usedVram: 0, freeVram: 0, gpuUtil: 0,
        hasForeignProcess: false, available: false, reachable: false,
        lastQueried: Date.now(),
      };
    }
  }

  /**
   * Piggyback: update a single host's cache entry after any SSH op on that host.
   */
  async updateHostGpuCache(hostname: string): Promise<void> {
    const hostConfig = this.config.hosts.find(h => h.hostname === hostname || h.name === hostname);
    if (!hostConfig) return;
    try {
      const entry = await this._queryOneHost(hostConfig);
      this.gpuCache.set(hostConfig.name, { status: entry, queriedAt: Date.now() });
    } catch {
      // Non-critical
    }
  }

  /**
   * Force refresh all hosts' GPU cache. Called before dispatch to ensure fresh data.
   */
  async prefetchGpuStatus(): Promise<void> {
    await Promise.allSettled(
      this.config.hosts.map(h => this.updateHostGpuCache(h.name)),
    );
  }

  /**
   * Fetch progress.json from a specific host and path.
   * Returns null if file does not exist or cannot be parsed.
   */
  async fetchProgress(hostname: string, progressFile: string): Promise<{ step: number; total: number; elapsed_seconds: number; eta_seconds: number } | null> {
    try {
      const { stdout } = await this.execOnHost(hostname, `cat '${progressFile}' 2>/dev/null`);
      if (!stdout.trim()) return null;
      return JSON.parse(stdout) as { step: number; total: number; elapsed_seconds: number; eta_seconds: number };
    } catch {
      return null;
    }
  }

  async destroy(): Promise<void> {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    for (const [name, ssh] of this.hostConnections) {
      ssh.dispose();
      this.logger.debug({ host: name }, 'Host connection closed');
    }
    this.hostConnections.clear();
    this.jumpSSH.dispose();
    this.jumpConnected = false;
    this.logger.info('All SSH connections closed');
  }
}

// Self-registration
PluginManager.instance.registerExecutor(
  'workstation_ssh',
  (config) => new WorkstationSSHExecutor(config as WorkstationSSHExecutorConfig),
);
