// src/notifiers/discord-webhook.ts

import { BaseNotifier } from './base.js';
import { JobRecord, ChainRecord, JobStatus, DiscordWebhookNotifierConfig } from '../core/types.js';
import { createLogger } from '../core/logger.js';

const logger = createLogger('DiscordWebhookNotifier');

/** Color codes for Discord embeds */
const COLORS = {
  green: 0x3fb950,   // success / completed
  red: 0xf85149,     // failure
  yellow: 0xd29922,  // running / pending
  blue: 0x58a6ff,    // info
  grey: 0x8b949e,    // cancelled
} as const;

function statusColor(status: JobStatus): number {
  switch (status) {
    case JobStatus.COMPLETED:
      return COLORS.green;
    case JobStatus.FAILED:
    case JobStatus.TIMEOUT:
      return COLORS.red;
    case JobStatus.RUNNING:
    case JobStatus.SUBMITTED:
      return COLORS.yellow;
    case JobStatus.CANCELLED:
      return COLORS.grey;
    default:
      return COLORS.blue;
  }
}

function statusEmoji(status: JobStatus): string {
  switch (status) {
    case JobStatus.COMPLETED:
      return '✅';
    case JobStatus.FAILED:
      return '❌';
    case JobStatus.TIMEOUT:
      return '⏱️';
    case JobStatus.RUNNING:
      return '🔄';
    case JobStatus.CANCELLED:
      return '🚫';
    default:
      return '❓';
  }
}

function formatElapsed(seconds: number | null): string {
  if (seconds === null) return 'N/A';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

interface DiscordEmbed {
  title: string;
  color: number;
  description?: string;
  fields: Array<{ name: string; value: string; inline?: boolean }>;
  timestamp: string;
  footer?: { text: string };
}

interface DiscordPayload {
  content?: string;
  embeds: DiscordEmbed[];
}

export class DiscordWebhookNotifier extends BaseNotifier {
  readonly type = 'discord_webhook';
  private config: DiscordWebhookNotifierConfig;

  constructor(config: DiscordWebhookNotifierConfig) {
    super();
    this.config = config;
  }

  async initialize(): Promise<void> {
    // Validate the URL format
    try {
      new URL(this.config.url);
    } catch {
      throw new Error(`Invalid Discord webhook URL: ${this.config.url}`);
    }
    logger.info({ url: this.config.url }, 'DiscordWebhookNotifier initialized');
  }

  private async sendWebhook(payload: DiscordPayload): Promise<void> {
    try {
      const response = await fetch(this.config.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const text = await response.text();
        logger.error({ status: response.status, body: text }, 'Discord webhook request failed');
      }
    } catch (err) {
      logger.error({ err }, 'Failed to send Discord webhook');
    }
  }

  async notifyJobStarted(job: JobRecord): Promise<void> {
    const embed: DiscordEmbed = {
      title: `${statusEmoji(job.status)} ${job.spec.name} — Started`,
      color: COLORS.yellow,
      fields: [
        { name: 'Job ID', value: job.slurmJobId ?? 'N/A', inline: true },
        { name: 'Status', value: job.status, inline: true },
        { name: 'Partition', value: job.spec.resources.partition, inline: true },
        { name: 'Node', value: job.node ?? 'Allocating...', inline: true },
        { name: 'Alchemy ID', value: job.id.slice(0, 8), inline: true },
      ],
      timestamp: new Date().toISOString(),
    };

    const payload: DiscordPayload = {
      content: this.config.mentionId
        ? `${this.config.mentionId} Job started`
        : undefined,
      embeds: [embed],
    };

    await this.sendWebhook(payload);
  }

  async notifyJobCompleted(job: JobRecord): Promise<void> {
    const fields: DiscordEmbed['fields'] = [
      { name: 'Job ID', value: job.slurmJobId ?? 'N/A', inline: true },
      { name: 'Elapsed', value: formatElapsed(job.elapsed), inline: true },
      { name: 'Node', value: job.node ?? 'N/A', inline: true },
      { name: 'Exit Code', value: String(job.exitCode ?? 0), inline: true },
      { name: 'Partition', value: job.spec.resources.partition, inline: true },
      { name: 'Alchemy ID', value: job.id.slice(0, 8), inline: true },
    ];

    // Include extracted metrics if available
    if (job.metrics && Object.keys(job.metrics).length > 0) {
      const metricsStr = Object.entries(job.metrics)
        .map(([k, v]) => `${k}: ${typeof v === 'number' ? v.toFixed(4) : v}`)
        .join('\n');
      fields.push({ name: 'Metrics', value: `\`\`\`\n${metricsStr}\n\`\`\``, inline: false });
    }

    const embed: DiscordEmbed = {
      title: `${statusEmoji(JobStatus.COMPLETED)} ${job.spec.name} — Completed`,
      color: COLORS.green,
      fields,
      timestamp: new Date().toISOString(),
      footer: { text: `Command: ${job.spec.command.slice(0, 80)}` },
    };

    const payload: DiscordPayload = {
      content: this.config.mentionId
        ? `${this.config.mentionId} Job completed successfully`
        : undefined,
      embeds: [embed],
    };

    await this.sendWebhook(payload);
  }

  async notifyJobFailed(job: JobRecord, logTail?: string): Promise<void> {
    const fields: DiscordEmbed['fields'] = [
      { name: 'Job ID', value: job.slurmJobId ?? 'N/A', inline: true },
      { name: 'Elapsed', value: formatElapsed(job.elapsed), inline: true },
      { name: 'Node', value: job.node ?? 'N/A', inline: true },
      { name: 'Exit Code', value: String(job.exitCode ?? -1), inline: true },
      { name: 'Partition', value: job.spec.resources.partition, inline: true },
      { name: 'Alchemy ID', value: job.id.slice(0, 8), inline: true },
    ];

    // Include last 20 lines of error log if available and configured
    if (logTail && this.config.includeTraceback !== false) {
      const tail = logTail.split('\n').slice(-20).join('\n');
      if (tail.trim()) {
        fields.push({
          name: 'Last Log Lines',
          value: `\`\`\`\n${tail.slice(0, 1000)}\n\`\`\``,
          inline: false,
        });
      }
    }

    const embed: DiscordEmbed = {
      title: `${statusEmoji(JobStatus.FAILED)} ${job.spec.name} — Failed`,
      color: COLORS.red,
      fields,
      timestamp: new Date().toISOString(),
      footer: { text: `Command: ${job.spec.command.slice(0, 80)}` },
    };

    const payload: DiscordPayload = {
      content: this.config.mentionId
        ? `${this.config.mentionId} Job FAILED`
        : undefined,
      embeds: [embed],
    };

    await this.sendWebhook(payload);
  }

  async notifyChainCompleted(chain: ChainRecord): Promise<void> {
    const embed: DiscordEmbed = {
      title: `✅ Chain "${chain.spec.name}" — Completed`,
      color: COLORS.green,
      fields: [
        { name: 'Chain ID', value: chain.id.slice(0, 8), inline: true },
        { name: 'Strategy', value: chain.spec.strategy, inline: true },
        { name: 'Total Jobs', value: String(chain.jobIds.length), inline: true },
        { name: 'Status', value: chain.status, inline: true },
      ],
      timestamp: new Date().toISOString(),
    };

    const payload: DiscordPayload = {
      content: this.config.mentionId
        ? `${this.config.mentionId} Chain completed`
        : undefined,
      embeds: [embed],
    };

    await this.sendWebhook(payload);
  }

  async notifyChainFailed(chain: ChainRecord, failedJob: JobRecord): Promise<void> {
    const embed: DiscordEmbed = {
      title: `❌ Chain "${chain.spec.name}" — Failed`,
      color: COLORS.red,
      fields: [
        { name: 'Chain ID', value: chain.id.slice(0, 8), inline: true },
        { name: 'Strategy', value: chain.spec.strategy, inline: true },
        { name: 'Failed Job', value: failedJob.spec.name, inline: true },
        { name: 'Slurm Job ID', value: failedJob.slurmJobId ?? 'N/A', inline: true },
        { name: 'Node', value: failedJob.node ?? 'N/A', inline: true },
        { name: 'Exit Code', value: String(failedJob.exitCode ?? -1), inline: true },
      ],
      timestamp: new Date().toISOString(),
    };

    const payload: DiscordPayload = {
      content: this.config.mentionId
        ? `${this.config.mentionId} Chain FAILED`
        : undefined,
      embeds: [embed],
    };

    await this.sendWebhook(payload);
  }

  async destroy(): Promise<void> {
    // Nothing to clean up for HTTP-based notifier
  }
}
