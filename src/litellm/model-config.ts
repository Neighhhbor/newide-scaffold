/**
 * ================================================
 * Model Configuration Manager
 * ================================================
 * Manages per-task model configurations.
 * Supports registration, lookup, and dynamic updates.
 */

import type {
  LiteLLMTaskConfig,
  LiteLLMTaskType,
  ModelEntry,
  ModelSelectionStrategy,
} from './types';

export class ModelConfigManager {
  private readonly configs = new Map<LiteLLMTaskType, LiteLLMTaskConfig>();

  /** Register or update a task's model configuration */
  register(config: LiteLLMTaskConfig): void {
    this.configs.set(config.task, config);
  }

  /** Register multiple configurations at once */
  registerAll(configs: LiteLLMTaskConfig[]): void {
    for (const cfg of configs) {
      this.configs.set(cfg.task, cfg);
    }
  }

  /** Look up model config for a task */
  get(task: LiteLLMTaskType): LiteLLMTaskConfig | undefined {
    return this.configs.get(task);
  }

  /** Check if a task has registered configuration */
  has(task: LiteLLMTaskType): boolean {
    return this.configs.has(task);
  }

  /** Remove a task's configuration */
  unregister(task: LiteLLMTaskType): boolean {
    return this.configs.delete(task);
  }

  /** Get all registered task types */
  getTasks(): LiteLLMTaskType[] {
    return Array.from(this.configs.keys());
  }

  /** Get all configurations */
  getAll(): LiteLLMTaskConfig[] {
    return Array.from(this.configs.values());
  }

  /** Update a specific task's strategy */
  setStrategy(task: LiteLLMTaskType, strategy: ModelSelectionStrategy): boolean {
    const cfg = this.configs.get(task);
    if (!cfg) return false;
    cfg.strategy = strategy;
    return true;
  }

  /** Update a specific task's timeout */
  setTimeout(task: LiteLLMTaskType, timeoutMs: number): boolean {
    const cfg = this.configs.get(task);
    if (!cfg) return false;
    cfg.timeoutMs = timeoutMs;
    return true;
  }

  /** Update a specific task's max retries */
  setMaxRetries(task: LiteLLMTaskType, maxRetries: number): boolean {
    const cfg = this.configs.get(task);
    if (!cfg) return false;
    cfg.maxRetries = maxRetries;
    return true;
  }

  /** Replace model entries for a task */
  setModels(task: LiteLLMTaskType, models: ModelEntry[]): boolean {
    const cfg = this.configs.get(task);
    if (!cfg) return false;
    cfg.models = models;
    return true;
  }
}
