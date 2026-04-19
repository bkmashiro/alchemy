// src/core/config.ts

import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { ConfigError } from './errors.js';
import type { AlchemyConfig } from './types.js';

const SlurmSSHExecutorConfigSchema = z.object({
  type: z.literal('slurm_ssh'),
  jumpHost: z.string(),
  computeHost: z.string(),
  user: z.string(),
  projectRoot: z.string(),
  logDir: z.string(),
  condaEnvBin: z.string(),
  defaultEnv: z.record(z.string()).optional(),
  privateKeyPath: z.string().optional(),
  connectTimeout: z.number().optional(),
});

const LocalExecutorConfigSchema = z.object({
  type: z.literal('local'),
  workingDir: z.string(),
  logDir: z.string(),
});

const WorkstationHostSchema = z.object({
  name: z.string(),
  hostname: z.string(),
  gpuType: z.string(),
  gpuCount: z.number().int().positive(),
  vram: z.number().positive(),
});

const WorkstationSSHExecutorConfigSchema = z.object({
  type: z.literal('workstation_ssh'),
  jumpHost: z.string(),
  hosts: z.array(WorkstationHostSchema).min(1),
  user: z.string(),
  projectRoot: z.string(),
  condaEnvBin: z.string(),
  defaultEnv: z.record(z.string()).optional(),
  privateKeyPath: z.string().optional(),
  connectTimeout: z.number().optional(),
});

const ExecutorConfigSchema = z.discriminatedUnion('type', [
  SlurmSSHExecutorConfigSchema,
  LocalExecutorConfigSchema,
  WorkstationSSHExecutorConfigSchema,
]);

const DiscordWebhookNotifierConfigSchema = z.object({
  type: z.literal('discord_webhook'),
  url: z.string().url(),
  mentionId: z.string().optional(),
  includeTraceback: z.boolean().optional(),
});

const NotifierConfigSchema = z.discriminatedUnion('type', [
  DiscordWebhookNotifierConfigSchema,
]);

const MetricsExtractorConfigSchema = z.object({
  type: z.literal('metrics_extractor'),
  patterns: z.array(z.string()).optional(),
});

const AutoSubmitAnalyzerConfigSchema = z.object({
  type: z.literal('auto_submit'),
  enabled: z.boolean().optional(),
});

const AnalyzerConfigSchema = z.discriminatedUnion('type', [
  MetricsExtractorConfigSchema,
  AutoSubmitAnalyzerConfigSchema,
]);

const WebhookConfigSchema = z.object({
  port: z.number().default(3457),
  publicUrl: z.string().url(),
  secret: z.string().optional(),
});

const DashboardConfigSchema = z.object({
  port: z.number().default(3456),
});

const RegistryConfigSchema = z.object({
  path: z.string().default('~/.alchemy/registry.db'),
});

const TunnelConfigSchema = z.object({
  token: z.string().optional(),
}).optional();

const AlchemyConfigSchema = z.object({
  executor: ExecutorConfigSchema,
  workstation: WorkstationSSHExecutorConfigSchema.optional(),
  notifiers: z.array(NotifierConfigSchema),
  analyzers: z.array(AnalyzerConfigSchema).optional(),
  webhook: WebhookConfigSchema,
  tunnel: TunnelConfigSchema,
  dashboard: DashboardConfigSchema.optional(),
  registry: RegistryConfigSchema,
});

/**
 * Load and validate the Alchemy config file.
 *
 * Resolution order:
 * 1. Explicit path (from CLI --config)
 * 2. ./alchemy.config.yaml
 * 3. ~/.alchemy/config.yaml
 *
 * Expands ~ in registry.path.
 *
 * @throws ConfigError if no config found or validation fails
 */
export function loadConfig(explicitPath?: string): AlchemyConfig {
  const candidates = [
    explicitPath,
    join(process.cwd(), 'alchemy.config.yaml'),
    join(homedir(), '.alchemy', 'config.yaml'),
  ].filter(Boolean) as string[];

  for (const path of candidates) {
    if (existsSync(path)) {
      const raw = readFileSync(path, 'utf-8');
      const parsed = parseYaml(raw) as unknown;
      const result = AlchemyConfigSchema.safeParse(parsed);
      if (!result.success) {
        throw new ConfigError(`Invalid config at ${path}: ${result.error.message}`);
      }
      // Expand ~ in paths
      const config = result.data;
      if (config.registry.path.startsWith('~')) {
        config.registry.path = config.registry.path.replace('~', homedir());
      }
      return config as AlchemyConfig;
    }
  }

  throw new ConfigError(
    'No config file found. Create ~/.alchemy/config.yaml or ./alchemy.config.yaml',
  );
}
