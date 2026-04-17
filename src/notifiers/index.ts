// src/notifiers/index.ts
// Re-exports and self-registration of all notifiers.

export { BaseNotifier } from './base.js';
export { DiscordWebhookNotifier } from './discord-webhook.js';

// Self-registration: importing this module registers all notifiers in the PluginManager.
import { PluginManager } from '../core/plugin-manager.js';
import { DiscordWebhookNotifier } from './discord-webhook.js';
import { DiscordWebhookNotifierConfig } from '../core/types.js';

PluginManager.instance.registerNotifier(
  'discord_webhook',
  (config) => new DiscordWebhookNotifier(config as DiscordWebhookNotifierConfig),
);
