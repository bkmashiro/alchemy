// src/core/types.ts
// ============================================================
// All types for Alchemy. This file is the single source of truth.
// NOTE: This is a stub file created by Agent B for compilation.
// Agent A's implementation will replace the non-type parts.
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
  PENDING = 'pending',
  SUBMITTED = 'submitted',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
  TIMEOUT = 'timeout',
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
  id?: number;
  jobId: AlchemyJobId;
  type: JobEventType;
  timestamp: ISOTimestamp;
  payload: Record<string, unknown>;
}

// ─── Resource Spec ───────────────────────────────────────────

export interface ResourceSpec {
  partition: string;
  time: string;
  mem: string;
  gpus: number;
  cpusPerTask?: number;
  extraDirectives?: string[];
  env?: Record<string, string>;
}

export const DEFAULT_RESOURCE_SPEC: ResourceSpec = {
  partition: 't4',
  time: '01:00:00',
  mem: '16G',
  gpus: 1,
};

// ─── Job Spec ────────────────────────────────────────────────

export interface JobSpec {
  name: string;
  command: string;
  resources: ResourceSpec;
  workingDir?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  envBinPath?: string;
  disableWebhook?: boolean;
}

// ─── Job Record ──────────────────────────────────────────────

export interface JobRecord {
  id: AlchemyJobId;
  slurmJobId: SlurmJobId | null;
  spec: JobSpec;
  status: JobStatus;
  executorType: string;
  chainId: AlchemyChainId | null;
  chainIndex: number | null;
  exitCode: number | null;
  node: string | null;
  elapsed: number | null;
  logPath: string | null;
  metrics: MetricsMap | null;
  createdAt: ISOTimestamp;
  updatedAt: ISOTimestamp;
}

// ─── Metrics ─────────────────────────────────────────────────

export type MetricsMap = Record<string, number>;

export interface AnalysisResult {
  jobId: AlchemyJobId;
  metrics: MetricsMap;
  shouldContinueChain: boolean;
  summary: string;
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
  PARTIAL = 'partial',
}

export type ConditionExpr = string;

export interface ChainStepSpec {
  stepId: string;
  job: JobSpec;
  dependsOn?: string[];
  condition?: ConditionExpr;
}

export interface ChainSpec {
  name: string;
  strategy: ChainStrategyType;
  steps: ChainStepSpec[];
  tags?: string[];
  metadata?: Record<string, unknown>;
  sweepGrid?: Record<string, (string | number)[]>;
  sweepBaseJob?: JobSpec;
  maxConcurrent?: number;
  failFast?: boolean;
}

export interface ChainRecord {
  id: AlchemyChainId;
  spec: ChainSpec;
  status: ChainStatus;
  jobIds: AlchemyJobId[];
  createdAt: ISOTimestamp;
  updatedAt: ISOTimestamp;
}

// ─── Executor Config ─────────────────────────────────────────

export interface SlurmSSHExecutorConfig {
  type: 'slurm_ssh';
  jumpHost: string;
  computeHost: string;
  user: string;
  projectRoot: string;
  logDir: string;
  condaEnvBin: string;
  defaultEnv?: Record<string, string>;
  privateKeyPath?: string;
  connectTimeout?: number;
}

export interface LocalExecutorConfig {
  type: 'local';
  workingDir: string;
  logDir: string;
}

export type ExecutorConfig = SlurmSSHExecutorConfig | LocalExecutorConfig;

// ─── Notifier Config ─────────────────────────────────────────

export interface DiscordWebhookNotifierConfig {
  type: 'discord_webhook';
  url: string;
  mentionId?: string;
  includeTraceback?: boolean;
}

export type NotifierConfig = DiscordWebhookNotifierConfig;

// ─── Analyzer Config ─────────────────────────────────────────

export interface MetricsExtractorConfig {
  type: 'metrics_extractor';
  patterns?: string[];
}

export interface AutoSubmitAnalyzerConfig {
  type: 'auto_submit';
  enabled?: boolean;
}

export type AnalyzerConfig = MetricsExtractorConfig | AutoSubmitAnalyzerConfig;

// ─── Webhook Config ──────────────────────────────────────────

export interface WebhookConfig {
  port: number;
  publicUrl: string;
  secret?: string;
}

// ─── Dashboard Config ────────────────────────────────────────

export interface DashboardConfig {
  port: number;
}

// ─── Registry Config ─────────────────────────────────────────

export interface RegistryConfig {
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

export interface WebhookPayload {
  jobId: string;
  jobName: string;
  status: 'completed' | 'failed' | 'timeout';
  exitCode: number;
  elapsed: number;
  node: string;
  signature?: string;
  alchemyJobId?: string;
}

// ─── Plugin Registration ─────────────────────────────────────

export interface PluginRegistration<T = unknown> {
  type: string;
  factory: (config: T) => unknown;
}

export enum PluginCategory {
  EXECUTOR = 'executor',
  NOTIFIER = 'notifier',
  ANALYZER = 'analyzer',
  STRATEGY = 'strategy',
}

// ─── YAML Job File Format ────────────────────────────────────

export interface AlchemyJobFile {
  version: '1';
  job?: JobSpec;
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
  id: string;
  type: 'job' | 'chain';
}
