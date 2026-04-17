// src/analyzers/index.ts
// Re-exports and self-registration of all analyzers.

export { BaseAnalyzer } from './base.js';
export { MetricsExtractor } from './metrics-extractor.js';
export { AutoSubmitAnalyzer } from './auto-submit.js';
export type { JobSubmitter } from './auto-submit.js';

// Self-registration: importing this module registers all analyzers in the PluginManager.
import { PluginManager } from '../core/plugin-manager.js';
import { MetricsExtractor } from './metrics-extractor.js';
import { AutoSubmitAnalyzer } from './auto-submit.js';
import { MetricsExtractorConfig, AutoSubmitAnalyzerConfig } from '../core/types.js';

PluginManager.instance.registerAnalyzer(
  'metrics_extractor',
  (config) => new MetricsExtractor(config as MetricsExtractorConfig),
);

PluginManager.instance.registerAnalyzer(
  'auto_submit',
  (config) => new AutoSubmitAnalyzer(config as AutoSubmitAnalyzerConfig),
);
