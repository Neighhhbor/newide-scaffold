/**
 * ================================================
 * Model Router
 * ================================================
 * Selects the best model for a given task using
 * configurable strategies: order, auto, cheapest, fastest.
 */

import type {
  LiteLLMTaskType,
  ModelEntry,
  ModelSelectionStrategy,
  LiteLLMTaskConfig,
} from './contract';

// ──────────────────────────────────────────────────────────
// Provider Detection Utilities
// ──────────────────────────────────────────────────────────

const ENV_KEYS: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GOOGLE_API_KEY',
  azure: 'AZURE_API_KEY',
  ollama: 'OLLAMA_HOST',
};

/** Check which providers are available in environment */
export function detectAvailableProviders(): string[] {
  const available: string[] = [];
  for (const [provider, envKey] of Object.entries(ENV_KEYS)) {
    if (process.env[envKey]) {
      available.push(provider);
    }
  }
  return available;
}

/** Check if a specific provider is available */
export function isProviderAvailable(provider: string): boolean {
  const envKey = ENV_KEYS[provider.toLowerCase()];
  if (!envKey) return false;
  return !!process.env[envKey];
}

/**
 * Auto-select models based on available API keys.
 * Disabled entries for unavailable providers are filtered out.
 */
export function autoSelectModels(entries: ModelEntry[]): ModelEntry[] {
  return entries
    .filter((e) => {
      if (e.provider === 'ollama') return true;
      return isProviderAvailable(e.provider);
    })
    .map((e, i) => ({ ...e, order: i + 1 }));
}

export interface ModelSelection {
  /** Selected model entry */
  entry: ModelEntry;
  /** The strategy used for selection */
  strategy: ModelSelectionStrategy;
  /** Index in the model list */
  index: number;
}

/** Error thrown when no model can be selected */
export class NoModelAvailableError extends Error {
  constructor(
    public readonly task: LiteLLMTaskType,
    public readonly reason: string,
  ) {
    super(`No model available for task "${task}": ${reason}`);
    this.name = 'NoModelAvailableError';
  }
}

export class ModelRouter {
  /** Select a model for the given task */
  select(task: LiteLLMTaskType, config: LiteLLMTaskConfig): ModelSelection {
    const strategy = config.strategy ?? 'order';
    const candidates = getEnabledCandidates(config.models ?? []);

    if (candidates.length === 0) {
      throw new NoModelAvailableError(task, 'no enabled models');
    }

    switch (strategy) {
      case 'order':
        return this.selectByOrder(task, candidates, strategy);
      case 'auto':
        return this.selectByAuto(task, candidates, strategy);
      case 'cheapest':
        return this.selectByCheapest(task, candidates, strategy);
      case 'fastest':
        return this.selectByFastest(task, candidates, strategy);
      default:
        if (typeof strategy === 'object' && strategy.type === 'explicit') {
          return this.selectExplicit(task, candidates, strategy.model);
        }
        throw new NoModelAvailableError(task, `unknown strategy: ${JSON.stringify(strategy)}`);
    }
  }

  /** Select the nth fallback model (for retries) */
  selectFallback(
    task: LiteLLMTaskType,
    config: LiteLLMTaskConfig,
    attemptIndex: number,
  ): ModelSelection {
    const candidates = getEnabledCandidates(config.models ?? []);
    if (attemptIndex >= candidates.length) {
      throw new NoModelAvailableError(task, `no fallback model at index ${attemptIndex}`);
    }
    const entry = candidates[attemptIndex]!;
    return {
      entry,
      strategy: { type: 'explicit', model: entry.model },
      index: attemptIndex,
    };
  }

  // ── Selection strategies ──

  private selectByOrder(
    task: LiteLLMTaskType,
    candidates: ModelEntry[],
    strategy: ModelSelectionStrategy,
  ): ModelSelection {
    const sorted = [...candidates].sort((a, b) => a.order - b.order);
    return {
      entry: sorted[0]!,
      strategy,
      index: candidates.indexOf(sorted[0]!),
    };
  }

  private selectByAuto(
    task: LiteLLMTaskType,
    candidates: ModelEntry[],
    strategy: ModelSelectionStrategy,
  ): ModelSelection {
    const available = candidates.filter(
      (m) => m.provider === 'ollama' || isProviderAvailable(m.provider),
    );
    if (available.length === 0) {
      throw new NoModelAvailableError(task, 'no providers available (check API keys)');
    }
    const sorted = available.sort((a, b) => a.order - b.order);
    return {
      entry: sorted[0]!,
      strategy,
      index: candidates.indexOf(sorted[0]!),
    };
  }

  private selectByCheapest(
    task: LiteLLMTaskType,
    candidates: ModelEntry[],
    strategy: ModelSelectionStrategy,
  ): ModelSelection {
    const sorted = [...candidates]
      .filter((m) => m.costPer1kTokens !== undefined)
      .sort((a, b) => (a.costPer1kTokens ?? Infinity) - (b.costPer1kTokens ?? Infinity));
    if (sorted.length === 0) {
      return this.selectByOrder(task, candidates, strategy);
    }
    return {
      entry: sorted[0]!,
      strategy,
      index: candidates.indexOf(sorted[0]!),
    };
  }

  private selectByFastest(
    task: LiteLLMTaskType,
    candidates: ModelEntry[],
    strategy: ModelSelectionStrategy,
  ): ModelSelection {
    // Heuristic: smaller context = faster; known fast models = faster
    const latencyScore = (m: ModelEntry): number => {
      if (m.model.includes('flash-lite')) return 1;
      if (m.model.includes('mini')) return 2;
      if (m.model.includes('flash')) return 3;
      if (m.model.includes('haiku')) return 4;
      if (m.model.includes('sonnet')) return 5;
      return 10;
    };
    const sorted = [...candidates].sort((a, b) => latencyScore(a) - latencyScore(b));
    return {
      entry: sorted[0]!,
      strategy,
      index: candidates.indexOf(sorted[0]!),
    };
  }

  private selectExplicit(
    task: LiteLLMTaskType,
    candidates: ModelEntry[],
    modelName: string,
  ): ModelSelection {
    const idx = candidates.findIndex((m) => m.model === modelName);
    if (idx === -1) {
      throw new NoModelAvailableError(task, `explicit model "${modelName}" not found`);
    }
    return {
      entry: candidates[idx]!,
      strategy: { type: 'explicit', model: modelName },
      index: idx,
    };
  }
}

/** Filter to enabled models only */
function getEnabledCandidates(models: ModelEntry[]): ModelEntry[] {
  return models.filter((m) => m.enabled !== false);
}
