// src/analyzers/metrics-extractor.ts

import { BaseAnalyzer } from './base.js';
import {
  JobRecord,
  AnalysisResult,
  MetricsMap,
  MetricsExtractorConfig,
} from '../core/types.js';
import { createLogger } from '../core/logger.js';

const logger = createLogger('MetricsExtractor');

/**
 * Default patterns for common ML metric extraction.
 * Each pattern should match metric key=value or key: value style logging.
 */
const DEFAULT_PATTERNS = [
  // key=value or key: value style (val_acc=0.87, loss: 1.23)
  /(?<key>(?:val_)?(?:loss|acc(?:uracy)?|f1(?:_score)?|auc|bleu|rouge(?:_[12l])?|perplexity|ppl|mse|mae|rmse|r2|precision|recall|map))\s*[=:]\s*(?<value>[\d.]+(?:e[+-]?\d+)?)/gi,
  // PyTorch Lightning style: "val_acc  0.8700"
  /(?<key>(?:train|val|test)_[a-z_]+)\s+(?<value>\d+\.\d+)/gi,
  // epoch N/N or step N
  /epoch\s+(?<value>\d+)(?:\/\d+)?/gi,
  // Generic key=value for common ml names
  /\b(?<key>[a-z][a-z0-9_]*(?:_(?:loss|acc|score|metric|rate|error|mean|std))?)\s*[=:]\s*(?<value>\d+\.?\d*(?:e[+-]?\d+)?)\b/gi,
];

/** These metric names will use the last seen value (handles repeating epoch logs) */
const LAST_VALUE_METRICS = new Set(['epoch', 'step', 'iteration', 'iter']);

export class MetricsExtractor extends BaseAnalyzer {
  readonly type = 'metrics_extractor';
  readonly priority = 10; // runs first

  private config: MetricsExtractorConfig;
  private compiledPatterns: RegExp[];

  constructor(config: MetricsExtractorConfig) {
    super();
    this.config = config;

    // Compile user-provided patterns or use defaults
    if (config.patterns && config.patterns.length > 0) {
      this.compiledPatterns = config.patterns.map(p => new RegExp(p, 'gi'));
    } else {
      this.compiledPatterns = DEFAULT_PATTERNS;
    }
  }

  async analyze(
    job: JobRecord,
    logContent: string,
    currentResult: AnalysisResult,
  ): Promise<AnalysisResult> {
    if (!logContent) {
      logger.debug({ jobId: job.id }, 'No log content to analyze');
      return currentResult;
    }

    const extracted = this.extractMetrics(logContent);
    const mergedMetrics: MetricsMap = { ...currentResult.metrics, ...extracted };

    const metricCount = Object.keys(extracted).length;
    logger.info({ jobId: job.id, metricCount, metrics: extracted }, 'Metrics extracted from logs');

    const summary = metricCount > 0
      ? `Extracted ${metricCount} metrics: ${Object.entries(extracted)
          .map(([k, v]) => `${k}=${v.toFixed(4)}`)
          .join(', ')}`
      : 'No metrics found in logs';

    return {
      ...currentResult,
      metrics: mergedMetrics,
      summary: currentResult.summary
        ? `${currentResult.summary}\n${summary}`
        : summary,
    };
  }

  /**
   * Extract metrics from log content using all configured patterns.
   * Returns the last observed value for each metric key.
   */
  private extractMetrics(logContent: string): MetricsMap {
    const metrics: MetricsMap = {};
    const allValues: Record<string, number[]> = {};

    for (const pattern of this.compiledPatterns) {
      // Reset lastIndex since patterns have 'g' flag
      pattern.lastIndex = 0;

      let match: RegExpExecArray | null;
      while ((match = pattern.exec(logContent)) !== null) {
        const groups = match.groups;
        if (!groups) continue;

        const rawValue = groups['value'];
        if (!rawValue) continue;

        const value = parseFloat(rawValue);
        if (isNaN(value)) continue;

        // Determine the key
        let key: string;
        if (groups['key']) {
          key = groups['key'].toLowerCase().trim();
        } else {
          // Pattern matched just a value (e.g., epoch N)
          // Infer key from the matched text
          const matchText = match[0]!.toLowerCase();
          if (matchText.startsWith('epoch')) {
            key = 'epoch';
          } else if (matchText.startsWith('step')) {
            key = 'step';
          } else {
            continue; // skip if we can't determine key
          }
        }

        // Skip obviously non-metric keys
        if (this.shouldSkipKey(key)) continue;

        if (!allValues[key]) allValues[key] = [];
        allValues[key]!.push(value);
      }

      // Reset pattern for next use
      pattern.lastIndex = 0;
    }

    // For most metrics, use the last value (training typically logs increasing epochs)
    for (const [key, values] of Object.entries(allValues)) {
      if (values.length === 0) continue;
      // For epoch/step, use the maximum (last seen)
      // For other metrics, use the last value seen
      metrics[key] = values[values.length - 1]!;
    }

    return metrics;
  }

  /**
   * Skip keys that are clearly not metrics (single chars, very long, etc.)
   */
  private shouldSkipKey(key: string): boolean {
    if (key.length <= 1) return true;
    if (key.length > 50) return true;
    // Skip keys that look like python variable assignments in code
    if (/^(if|for|while|def|class|import|from|return|true|false|none)$/.test(key)) return true;
    return false;
  }
}
