// src/core/types.ts
// ============================================================
// All types for Alchemy. This file is the single source of truth.
// ============================================================

// ─── Primitives ──────────────────────────────────────────────

/** Slurm job ID (numeric string from sbatch output) */
export type SlurmJobId = string;

/** Internal UUID for alchemy tracking */
export type AlchemyJobId = string;

/** Internal UUID for chain tracking */
export type AlchemyChainId = string;

/** ISO-8601 timestamp string */
export type ISOTimestamp = string;

// ─── Job Status ──────────────────────────────────────────────

export enum JobStatus {
  /** Created locally, not yet submitted */
  PENDING = 'pending',
  /** Submitted to executor, awaiting start */
  SUBMITTED = 'submitted',
  /** Currently running on compute node */
  RUNNING = 'running',
  /** Completed successfully (exit code 0) */
  COMPLETED = 'completed',
  /** Failed (non-zero exit code) */
  FAILED = 'failed',
  /** Cancelled by user or system */
  CANCELLED = 'cancelled',
  /** Timed out */
  TIMEOUT = 'timeout',
  /** Status unknown (e.g., lost SSH connection) */
  UNKNOWN = 'unknown',
}

// ─── Job Event ───────────────────────────────────────────────

export enum JobEventType {
  CREATED = 'created',
  SUBMITTED = 'submitted',
  STARTED = 'started',
  PROGRESS = 'progress',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
  TIMEOUT = 'timeout',
  LOG_APPENDED = 'log_appended',
  METRICS_EXTRACTED = 'metrics_extracted',
  NOTIFICATION_SENT = 'notification_sent',
  ANALYSIS_COMPLETE = 'analysis_complete',
}

export interface JobEvent {
  /** Auto-increment ID from SQLite */
  id?: number;
  /** The alchemy job ID this event belongs to */
  jobId: AlchemyJobId;
  /** Event type */
  type: JobEventType;
  /** ISO timestamp */
  timestamp: ISOTimestamp;
  /** Arbitrary JSON payload (varies by event type) */
  payload: Record<string, unknown>;
}

// ─── Resource Spec ───────────────────────────────────────────

export interface ResourceSpec {
  /** Slurm partition name. Default: 't4' */
  partition: string;
  /** Wall-clock time limit. Format: HH:MM:SS. Default: '01:00:00' */
  time: string;
  /** Memory allocation. Default: '16G' */
  mem: string;
  /** Number of GPUs. Default: 1 */
  gpus: number;
  /** Number of CPUs per task. Default: undefined (Slurm default) */
  cpusPerTask?: number;
  /** Additional Slurm directives as raw strings (e.g., ['--exclusive', '--constraint=a100']) */
  extraDirectives?: string[];
  /** Environment variables to set in the job script */
  env?: Record<string, string>;
}

/** Default resource spec (matches existing submit script defaults) */
export const DEFAULT_RESOURCE_SPEC: ResourceSpec = {
  partition: 't4',
  time: '01:00:00',
  mem: '16G',
  gpus: 1,
};

// ─── Job Spec ────────────────────────────────────────────────

export interface JobSpec {
  /** Human-readable job name (maps to SLURM --job-name). Must be [a-zA-Z0-9_-] */
  name: string;
  /** The command to execute (e.g., "python train.py --lr 1e-4") */
  command: string;
  /** Resource requirements */
  resources: ResourceSpec;
  /** Working directory on the remote cluster. Default: executor's projectRoot */
  workingDir?: string;
  /** Tags for filtering/grouping */
  tags?: string[];
  /** Arbitrary metadata */
  metadata?: Record<string, unknown>;
  /**
   * Path to conda/venv bin directory to prepend to PATH.
   * Default: executor config's condaEnvBin
   */
  envBinPath?: string;
  /**
   * If true, do NOT inject the webhook notification trap into the sbatch script.
   * Default: false
   */
  disableWebhook?: boolean;
}

// ─── Job Record ──────────────────────────────────────────────

export interface JobRecord {
  /** Internal alchemy UUID */
  id: AlchemyJobId;
  /** Slurm job ID (null until submitted) */
  slurmJobId: SlurmJobId | null;
  /** The original job spec */
  spec: JobSpec;
  /** Current status */
  status: JobStatus;
  /** Which executor handled this job */
  executorType: string;
  /** Chain ID if part of a chain, null otherwise */
  chainId: AlchemyChainId | null;
  /** Position in chain (0-based), null if not in chain */
  chainIndex: number | null;
  /** Exit code (null until completed/failed) */
  exitCode: number | null;
  /** Compute node hostname (null until started) */
  node: string | null;
  /** Wall-clock seconds elapsed (null until finished) */
  elapsed: number | null;
  /** Path to log file on remote cluster */
  logPath: string | null;
  /** Extracted metrics (populated by analyzer) */
  metrics: MetricsMap | null;
  /** Created timestamp */
  createdAt: ISOTimestamp;
  /** Last updated timestamp */
  updatedAt: ISOTimestamp;
}

// ─── Metrics ─────────────────────────────────────────────────

/**
 * Flat key-value map of metrics extracted from job output.
 * Keys use dot notation: "val_acc", "train_loss", "epoch", etc.
 * Values are always numbers (strings are parsed).
 */
export type MetricsMap = Record<string, number>;

export interface AnalysisResult {
  /** The job that was analyzed */
  jobId: AlchemyJobId;
  /** Extracted metrics */
  metrics: MetricsMap;
  /** Whether to auto-submit follow-up jobs */
  shouldContinueChain: boolean;
  /** Human-readable summary */
  summary: string;
  /** If shouldContinueChain, these are the follow-up job specs to submit */
  followUpJobs?: JobSpec[];
}

// ─── Chain Spec ──────────────────────────────────────────────

export enum ChainStrategyType {
  SEQUENTIAL = 'sequential',
  PARALLEL = 'parallel',
  CONDITIONAL = 'conditional',
  HYPERPARAM_SWEEP = 'sweep',
}

export enum ChainStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
  /** Some jobs succeeded, some failed, chain stopped */
  PARTIAL = 'partial',
}

/**
 * A condition expression evaluated against a job's metrics.
 * Uses a simple expression language:
 *   "metrics.val_acc > 0.85"
 *   "metrics.train_loss < 0.1"
 *   "metrics.epoch >= 50"
 *   "status == 'completed'"
 *
 * See ChainPlanner.evaluateCondition() for the parser.
 */
export type ConditionExpr = string;

export interface ChainStepSpec {
  /** Unique step ID within the chain (e.g., "train", "eval", "sweep_lr_001") */
  stepId: string;
  /** The job to run at this step */
  job: JobSpec;
  /** Step IDs that must complete before this step can start */
  dependsOn?: string[];
  /** Condition that must be true (evaluated against parent job metrics) for this step to run */
  condition?: ConditionExpr;
}

export interface ChainSpec {
  /** Human-readable chain name */
  name: string;
  /** Which strategy to use for orchestration */
  strategy: ChainStrategyType;
  /** Steps in the chain */
  steps: ChainStepSpec[];
  /** Tags for filtering */
  tags?: string[];
  /** Metadata */
  metadata?: Record<string, unknown>;
  /**
   * For sweep strategy: the parameter grid.
   * Keys are template variables in job commands: {{lr}}, {{batch_size}}
   * Values are arrays of values to sweep over.
   */
  sweepGrid?: Record<string, (string | number)[]>;
  /**
   * For sweep: the base job spec template.
   * Command may contain {{var}} placeholders replaced by sweep values.
   */
  sweepBaseJob?: JobSpec;
  /** Max concurrent jobs for parallel/sweep strategies. Default: unlimited */
  maxConcurrent?: number;
  /** If true, cancel remaining jobs on first failure. Default: false */
  failFast?: boolean;
}

export interface ChainRecord {
  /** Internal chain UUID */
  id: AlchemyChainId;
  /** The original chain spec */
  spec: ChainSpec;
  /** Current chain status */
  status: ChainStatus;
  /** All job IDs in this chain (in submission order) */
  jobIds: AlchemyJobId[];
  /** Created timestamp */
  createdAt: ISOTimestamp;
  /** Last updated timestamp */
  updatedAt: ISOTimestamp;
}

// ─── Executor Config ─────────────────────────────────────────

export interface SlurmSSHExecutorConfig {
  type: 'slurm_ssh';
  /** Jump host (SSH config name or user@host). E.g., 'shell2' */
  jumpHost: string;
  /** Compute host reachable from jump host. E.g., 'gpucluster2' */
  computeHost: string;
  /** SSH username */
  user: string;
  /** Project root on the cluster */
  projectRoot: string;
  /** Log directory on the cluster */
  logDir: string;
  /** Conda/venv bin path to prepend to PATH */
  condaEnvBin: string;
  /** Extra env vars to set in every job */
  defaultEnv?: Record<string, string>;
  /** SSH private key path (optional, uses ssh-agent by default) */
  privateKeyPath?: string;
  /** SSH connection timeout in ms. Default: 10000 */
  connectTimeout?: number;
}

export interface LocalExecutorConfig {
  type: 'local';
  /** Working directory for local jobs */
  workingDir: string;
  /** Log directory */
  logDir: string;
}

export type ExecutorConfig = SlurmSSHExecutorConfig | LocalExecutorConfig;

// ─── Notifier Config ─────────────────────────────────────────

export interface DiscordWebhookNotifierConfig {
  type: 'discord_webhook';
  /** Discord webhook URL */
  url: string;
  /** Discord user/role ID to mention (e.g., "<@1477359696129163506>") */
  mentionId?: string;
  /** Whether to include error tracebacks in failure messages. Default: true */
  includeTraceback?: boolean;
}

export type NotifierConfig = DiscordWebhookNotifierConfig;

// ─── Analyzer Config ─────────────────────────────────────────

export interface MetricsExtractorConfig {
  type: 'metrics_extractor';
  /**
   * Regex patterns to extract metrics from log output.
   * Each pattern must have a named group 'value' and optionally 'key'.
   * Default patterns match common ML frameworks (PyTorch Lightning, etc.)
   */
  patterns?: string[];
}

export interface AutoSubmitAnalyzerConfig {
  type: 'auto_submit';
  /** Enable auto-submission of follow-up chain steps. Default: true */
  enabled?: boolean;
}

export type AnalyzerConfig = MetricsExtractorConfig | AutoSubmitAnalyzerConfig;

// ─── Webhook Config ──────────────────────────────────────────

export interface WebhookConfig {
  /** Port for the webhook HTTP server. Default: 3457 */
  port: number;
  /**
   * Public URL where the webhook is reachable from the cluster.
   * E.g., an ngrok/Cloudflare tunnel URL.
   * This URL is injected into sbatch scripts so the cluster can call back.
   */
  publicUrl: string;
  /** Shared secret for HMAC verification (optional but recommended) */
  secret?: string;
}

// ─── Dashboard Config ────────────────────────────────────────

export interface DashboardConfig {
  /** Port for the dashboard HTTP server. Default: 3456 */
  port: number;
}

// ─── Registry Config ─────────────────────────────────────────

export interface RegistryConfig {
  /** Path to the SQLite database file. Default: ~/.alchemy/registry.db */
  path: string;
}

// ─── Top-Level Config ────────────────────────────────────────

export interface AlchemyConfig {
  executor: ExecutorConfig;
  notifiers: NotifierConfig[];
  analyzers?: AnalyzerConfig[];
  webhook: WebhookConfig;
  dashboard?: DashboardConfig;
  registry: RegistryConfig;
}

// ─── Webhook Payload ─────────────────────────────────────────

/** Payload sent by the injected curl in sbatch scripts on job completion */
export interface WebhookPayload {
  /** Slurm job ID */
  jobId: string;
  /** Slurm job name */
  jobName: string;
  /** 'completed' | 'failed' | 'timeout' */
  status: 'completed' | 'failed' | 'timeout' | 'started';
  /** Process exit code */
  exitCode: number;
  /** Wall-clock seconds elapsed */
  elapsed: number;
  /** Compute node hostname */
  node: string;
  /** HMAC signature of payload (if secret configured) */
  signature?: string;
  /** Alchemy job ID (injected as env var in sbatch script) */
  alchemyJobId?: string;
}

// ─── Plugin Registration ─────────────────────────────────────

export interface PluginRegistration<T = unknown> {
  /** Unique type identifier (e.g., 'slurm_ssh', 'discord_webhook') */
  type: string;
  /** Factory function that creates an instance from config */
  factory: (config: T) => unknown;
}

/**
 * Plugin categories for the plugin manager.
 */
export enum PluginCategory {
  EXECUTOR = 'executor',
  NOTIFIER = 'notifier',
  ANALYZER = 'analyzer',
  STRATEGY = 'strategy',
}

// ─── YAML Job File Format ────────────────────────────────────

/**
 * Schema for .yaml/.yml job files passed to `alchemy submit`.
 * Can define either a single job or a chain.
 */
export interface AlchemyJobFile {
  /** File format version */
  version: '1';
  /** Single job definition (mutually exclusive with chain) */
  job?: JobSpec;
  /** Chain definition (mutually exclusive with job) */
  chain?: ChainSpec;
}

// ─── API Response Types (Dashboard) ──────────────────────────

export interface ApiJobResponse {
  jobs: JobRecord[];
  total: number;
}

export interface ApiChainResponse {
  chains: ChainRecord[];
  total: number;
}

export interface ApiJobDetailResponse {
  job: JobRecord;
  events: JobEvent[];
}

export interface ApiChainDetailResponse {
  chain: ChainRecord;
  jobs: JobRecord[];
}

export interface ApiSubmitRequest {
  yaml: string;
}

export interface ApiSubmitResponse {
  /** Job ID (single job) or chain ID (chain) */
  id: string;
  type: 'job' | 'chain';
}
