// src/core/plugin-manager.ts
// Stub file — Agent A owns the implementation.

import { PluginCategory } from './types.js';
import { BaseExecutor } from '../executors/base.js';
import { BaseNotifier } from '../notifiers/base.js';
import { BaseAnalyzer } from '../analyzers/base.js';
import { BaseChainStrategy } from '../strategies/base.js';

type ExecutorFactory = (config: unknown) => BaseExecutor;
type NotifierFactory = (config: unknown) => BaseNotifier;
type AnalyzerFactory = (config: unknown) => BaseAnalyzer;
type StrategyFactory = () => BaseChainStrategy;

export class PluginManager {
  private static _instance: PluginManager;

  static get instance(): PluginManager {
    if (!PluginManager._instance) {
      PluginManager._instance = new PluginManager();
    }
    return PluginManager._instance;
  }

  private executors: Map<string, ExecutorFactory> = new Map();
  private notifiers: Map<string, NotifierFactory> = new Map();
  private analyzers: Map<string, AnalyzerFactory> = new Map();
  private strategies: Map<string, StrategyFactory> = new Map();

  registerExecutor(type: string, factory: ExecutorFactory): void {
    this.executors.set(type, factory);
  }

  registerNotifier(type: string, factory: NotifierFactory): void {
    this.notifiers.set(type, factory);
  }

  registerAnalyzer(type: string, factory: AnalyzerFactory): void {
    this.analyzers.set(type, factory);
  }

  registerStrategy(type: string, factory: StrategyFactory): void {
    this.strategies.set(type, factory);
  }

  createExecutor(type: string, config: unknown): BaseExecutor {
    const factory = this.executors.get(type);
    if (!factory) throw new Error(`Unknown executor type: ${type}`);
    return factory(config);
  }

  createNotifier(type: string, config: unknown): BaseNotifier {
    const factory = this.notifiers.get(type);
    if (!factory) throw new Error(`Unknown notifier type: ${type}`);
    return factory(config);
  }

  createAnalyzer(type: string, config: unknown): BaseAnalyzer {
    const factory = this.analyzers.get(type);
    if (!factory) throw new Error(`Unknown analyzer type: ${type}`);
    return factory(config);
  }

  createStrategy(type: string): BaseChainStrategy {
    const factory = this.strategies.get(type);
    if (!factory) throw new Error(`Unknown strategy type: ${type}`);
    return factory();
  }

  listPlugins(): Record<PluginCategory, string[]> {
    return {
      [PluginCategory.EXECUTOR]: [...this.executors.keys()],
      [PluginCategory.NOTIFIER]: [...this.notifiers.keys()],
      [PluginCategory.ANALYZER]: [...this.analyzers.keys()],
      [PluginCategory.STRATEGY]: [...this.strategies.keys()],
    };
  }
}
