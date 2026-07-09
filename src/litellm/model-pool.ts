/**
 * ================================================
 * Model Pool
 * ================================================
 * Central model management: configuration + routing + resolution.
 * Single entry point for model selection.
 */

import { ModelConfigManager } from './model-config';
import { ModelRouter, type ModelSelection } from './model-router';
import type { LiteLLMTaskType, LiteLLMTaskConfig, ModelEntry } from './types';

export interface ResolvedModel {
  /** The LiteLLM model identifier to send in API requests */
  litellmModel: string;
  /** Resolved timeout for this task */
  timeoutMs: number;
  /** Resolved max retries for this task */
  maxRetries: number;
  /** Resolved temperature */
  temperature: number;
  /** Resolved max tokens */
  maxTokens: number;
  /** The selection that produced this resolution */
  selection: ModelSelection;
}

export class ModelPool {
  readonly config: ModelConfigManager;
  readonly router: ModelRouter;

  constructor(
    private readonly globalDefaults: {
      defaultTimeoutMs: number;
      defaultMaxRetries: number;
      defaultTemperature: number;
      defaultMaxTokens: number;
    },
  ) {
    this.config = new ModelConfigManager();
    this.router = new ModelRouter();
  }

  /** Resolve the best model and settings for a task */
  resolve(task: LiteLLMTaskType): ResolvedModel {
    const cfg = this.config.get(task);
    if (!cfg) {
      throw new Error(
        `No model configuration for task "${task}". ` +
          `Registered tasks: [${this.config.getTasks().join(', ')}]`,
      );
    }

    const selection = this.router.select(task, cfg);

    return {
      litellmModel: selection.entry.litellmModel,
      timeoutMs: cfg.timeoutMs ?? this.globalDefaults.defaultTimeoutMs,
      maxRetries: cfg.maxRetries ?? this.globalDefaults.defaultMaxRetries,
      temperature: cfg.temperature ?? this.globalDefaults.defaultTemperature,
      maxTokens: cfg.maxTokens ?? this.globalDefaults.defaultMaxTokens,
      selection,
    };
  }

  /** Resolve a fallback model (for retries) */
  resolveFallback(task: LiteLLMTaskType, attemptIndex: number): ResolvedModel {
    const cfg = this.config.get(task);
    if (!cfg) {
      throw new Error(`No model configuration for task "${task}"`);
    }

    const selection = this.router.selectFallback(task, cfg, attemptIndex);

    return {
      litellmModel: selection.entry.litellmModel,
      timeoutMs: cfg.timeoutMs ?? this.globalDefaults.defaultTimeoutMs,
      maxRetries: cfg.maxRetries ?? this.globalDefaults.defaultMaxRetries,
      temperature: cfg.temperature ?? this.globalDefaults.defaultTemperature,
      maxTokens: cfg.maxTokens ?? this.globalDefaults.defaultMaxTokens,
      selection,
    };
  }

  /** Quick check: is this task configured? */
  canHandle(task: LiteLLMTaskType): boolean {
    return this.config.has(task);
  }

  /** Get all available models for a task (for inspection) */
  getAvailableModels(task: LiteLLMTaskType): ModelEntry[] {
    const cfg = this.config.get(task);
    if (!cfg) return [];
    return cfg.models.filter((m) => m.enabled !== false);
  }

  /** Register new task configuration (fluent API) */
  withConfig(config: LiteLLMTaskConfig): this {
    this.config.register(config);
    return this;
  }

  /** Register multiple configurations (fluent API) */
  withConfigs(configs: LiteLLMTaskConfig[]): this {
    this.config.registerAll(configs);
    return this;
  }
}
