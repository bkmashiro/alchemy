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
} from '../core/types.js';
import { SSHConnectionError, SubmissionError } from '../core/errors.js';
import { createLogger } from '../core/logger.js';
import { PluginManager } from '../core/plugin-manager.js';

export interface GPUQueryResult {
  host: WorkstationHost;
  memoryUsedMB: number;
  memoryTotalMB: number;
  memoryFreeMB: number;
  available: boolean;
}

/**
 * Executor for bare Linux workstations (no SLURM) via SSH + nohup.
 * Jobs are tracked by PID files on the remote machine.
 * External job ID format: "ws:<hostname>:<pid>"
 */
export class WorkstationSSHExecutor extends BaseExecutor {
  readonly type = 'workstation_ssh';
  private jumpSSH: NodeSSH;
  private hostConnections: Map<string, NodeSSH> = new Map();
  private config: WorkstationSSHExecutorConfig;
  private logger: pino.Logger;
  private webhookPublicUrl: string;

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
    await this.jumpSSH.connect({
      host: this.config.jumpHost,
      username: this.config.user,
      agent: process.env['SSH_AUTH_SOCK'],
      privateKeyPath: this.config.privateKeyPath,
      readyTimeout: this.config.connectTimeout ?? 10000,
    });
    this.logger.info({ host: this.config.jumpHost }, 'Connected to jump host');
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

    const stream = await new Promise<NodeJS.ReadWriteStream>((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this.jumpSSH as any).connection.forwardOut(
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
   */
  private async execOnHost(
    hostname: string,
    command: string,
  ): Promise<{ stdout: string; stderr: string }> {
    try {
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
    } catch (err) {
      // Drop cached connection and retry once
      this.hostConnections.delete(hostname);
      this.logger.warn({ err, host: hostname }, 'SSH command failed, attempting reconnect');
      try {
        const ssh = await this.getHostConnection(hostname);
        const result = await ssh.execCommand(command, {
          cwd: this.config.projectRoot,
        });
        return { stdout: result.stdout, stderr: result.stderr };
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
   * "auto" picks the host with the most free VRAM.
   */
  private async resolveHost(targetHost?: string): Promise<WorkstationHost> {
    if (targetHost && targetHost !== 'auto') {
      const host = this.config.hosts.find(h => h.name === targetHost || h.hostname === targetHost);
      if (!host) {
        throw new SubmissionError(`Unknown workstation host: ${targetHost}`, '');
      }
      return host;
    }

    // Auto-select: pick host with most free VRAM
    const results = await this.listAvailableHosts();
    const available = results.filter(r => r.available);
    if (available.length === 0) {
      throw new SubmissionError('No workstation hosts with available GPU memory', '');
    }
    available.sort((a, b) => b.memoryFreeMB - a.memoryFreeMB);
    return available[0]!.host;
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
    const host = await this.resolveHost(targetHostName);
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

    const writeCmd = `printf '%s' ${JSON.stringify(scriptContent)} > '${scriptPath}' && chmod +x '${scriptPath}'`;
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

      // Write PID file
      await this.execOnHost(hostname, `echo '${pid}' > '${pidPath}'`);

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

    try {
      // Check if process is still running
      const { stdout } = await this.execOnHost(
        hostname,
        `kill -0 ${pid} 2>/dev/null && echo RUNNING || echo STOPPED`,
      );

      if (stdout.trim() === 'RUNNING') {
        return { status: JobStatus.RUNNING, node: hostname };
      }

      // Process stopped — try to get exit code from wait or /proc
      // Since we can't wait on a non-child process, check if the log ends with error indicators
      return { status: JobStatus.COMPLETED, node: hostname };
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
        const { stdout } = await this.execOnHost(host.name, `tail -n ${tailLines} '${logPath}' 2>/dev/null`);
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
    const { stdout } = await this.execOnHost(hostname, `tail -n ${tailLines} '${logPath}' 2>/dev/null`);
    return stdout;
  }

  /**
   * Query GPU usage on a specific host via nvidia-smi.
   */
  async queryGPU(hostname: string): Promise<{ usedMB: number; totalMB: number }[]> {
    const { stdout } = await this.execOnHost(
      hostname,
      'nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader,nounits',
    );

    const gpus: { usedMB: number; totalMB: number }[] = [];
    for (const line of stdout.trim().split('\n')) {
      const parts = line.split(',').map(s => s.trim());
      if (parts.length >= 2) {
        gpus.push({
          usedMB: parseInt(parts[0]!, 10),
          totalMB: parseInt(parts[1]!, 10),
        });
      }
    }
    return gpus;
  }

  /**
   * Query all configured hosts concurrently and return availability info.
   * Each host query has a 5s timeout to avoid blocking on unreachable machines.
   */
  async listAvailableHosts(): Promise<GPUQueryResult[]> {
    const queryOne = async (host: WorkstationHost): Promise<GPUQueryResult> => {
      try {
        const gpus = await Promise.race([
          this.queryGPU(host.name),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('GPU query timeout')), 5000),
          ),
        ]);
        const totalUsed = gpus.reduce((sum, g) => sum + g.usedMB, 0);
        const totalMem = gpus.reduce((sum, g) => sum + g.totalMB, 0);
        const freeMB = totalMem - totalUsed;
        return {
          host,
          memoryUsedMB: totalUsed,
          memoryTotalMB: totalMem,
          memoryFreeMB: freeMB,
          available: freeMB > 2048,
        };
      } catch (err) {
        this.logger.warn({ host: host.name, err }, 'Failed to query GPU');
        return {
          host,
          memoryUsedMB: 0,
          memoryTotalMB: 0,
          memoryFreeMB: 0,
          available: false,
        };
      }
    };

    return Promise.all(this.config.hosts.map(queryOne));
  }

  async destroy(): Promise<void> {
    for (const [name, ssh] of this.hostConnections) {
      ssh.dispose();
      this.logger.debug({ host: name }, 'Host connection closed');
    }
    this.hostConnections.clear();
    this.jumpSSH.dispose();
    this.logger.info('All SSH connections closed');
  }
}

// Self-registration
PluginManager.instance.registerExecutor(
  'workstation_ssh',
  (config) => new WorkstationSSHExecutor(config as WorkstationSSHExecutorConfig),
);
