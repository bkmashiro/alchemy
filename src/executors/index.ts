// src/executors/index.ts — barrel + self-registration
// Importing these files triggers their self-registration with PluginManager

export * from './base.js';
export * from './slurm-ssh.js';
export * from './local.js';
