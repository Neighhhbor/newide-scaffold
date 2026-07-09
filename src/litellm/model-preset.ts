/**
 * ================================================
 * Model Presets — default model configurations
 * ================================================
 * Sensible defaults for common task types.
 * API keys are read from process.env (no per-task key config).
 */

import type { LiteLLMTaskConfig, ModelEntry, ModelSelectionStrategy } from './types';

// ──────────────────────────────────────────────────────────
// Helper: detect which providers have API keys available
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

// ──────────────────────────────────────────────────────────
// Default Model Presets (order-based with fallbacks)
// ──────────────────────────────────────────────────────────

/** "Quick & Cheap" — classification, intent detection */
export const QUICK_CHEAP_MODELS: ModelEntry[] = [
  {
    litellmModel: 'openai/gpt-4o-mini',
    provider: 'openai',
    order: 1,
    enabled: true,
    costPer1kTokens: 0.00015,
  },
  {
    litellmModel: 'anthropic/claude-3-5-haiku-latest',
    provider: 'anthropic',
    order: 2,
    enabled: true,
    costPer1kTokens: 0.00025,
  },
  {
    litellmModel: 'google/gemini-2.0-flash-lite',
    provider: 'google',
    order: 3,
    enabled: true,
    costPer1kTokens: 0.00008,
  },
];

/** "Balanced" — summarization, memory operations, planning */
export const BALANCED_MODELS: ModelEntry[] = [
  {
    litellmModel: 'openai/gpt-4o-mini',
    provider: 'openai',
    order: 1,
    enabled: true,
    costPer1kTokens: 0.00015,
  },
  {
    litellmModel: 'anthropic/claude-3-5-sonnet-latest',
    provider: 'anthropic',
    order: 2,
    enabled: true,
    costPer1kTokens: 0.003,
  },
  {
    litellmModel: 'google/gemini-2.0-flash',
    provider: 'google',
    order: 3,
    enabled: true,
    costPer1kTokens: 0.0001,
  },
];

/** "Strong" — complex reasoning, code generation, structured extraction */
export const STRONG_MODELS: ModelEntry[] = [
  {
    litellmModel: 'openai/gpt-4o',
    provider: 'openai',
    order: 1,
    enabled: true,
    costPer1kTokens: 0.0025,
  },
  {
    litellmModel: 'anthropic/claude-3-5-sonnet-latest',
    provider: 'anthropic',
    order: 2,
    enabled: true,
    costPer1kTokens: 0.003,
  },
  {
    litellmModel: 'google/gemini-2.0-pro',
    provider: 'google',
    order: 3,
    enabled: true,
    costPer1kTokens: 0.00125,
  },
];

/** "Coding" — specialized for code tasks */
export const CODING_MODELS: ModelEntry[] = [
  {
    litellmModel: 'openai/gpt-4o',
    provider: 'openai',
    order: 1,
    enabled: true,
    costPer1kTokens: 0.0025,
  },
  {
    litellmModel: 'anthropic/claude-3-5-sonnet-latest',
    provider: 'anthropic',
    order: 2,
    enabled: true,
    costPer1kTokens: 0.003,
  },
];

// ──────────────────────────────────────────────────────────
// Auto-Selection Strategy
// ──────────────────────────────────────────────────────────

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
    .map((e, i) => ({ ...e, order: i + 1 })); // Reorder after filtering
}

// ──────────────────────────────────────────────────────────
// Preset Task Configurations
// ──────────────────────────────────────────────────────────

/** Build a task config with defaults */
function makeTaskConfig(
  task: string,
  models: ModelEntry[],
  opts: {
    strategy?: ModelSelectionStrategy;
    timeoutMs?: number;
    maxRetries?: number;
    temperature?: number;
    maxTokens?: number;
  } = {},
): LiteLLMTaskConfig {
  return {
    task,
    models,
    strategy: opts.strategy ?? 'order',
    timeoutMs: opts.timeoutMs ?? 30000,
    maxRetries: opts.maxRetries ?? 3,
    temperature: opts.temperature ?? 0.3,
    maxTokens: opts.maxTokens ?? 2000,
  };
}

/** Get default task configurations */
export function getDefaultTaskConfigs(): LiteLLMTaskConfig[] {
  return [
    // Memory operations — quick & cheap
    makeTaskConfig('memory-compact', QUICK_CHEAP_MODELS, {
      timeoutMs: 15000,
      maxRetries: 2,
      temperature: 0.2,
    }),
    makeTaskConfig('memory-query', QUICK_CHEAP_MODELS, {
      timeoutMs: 10000,
      maxRetries: 2,
      temperature: 0.1,
    }),

    // Coordination — balanced, needs reasoning
    makeTaskConfig('coordinate-plan', BALANCED_MODELS, {
      timeoutMs: 30000,
      maxRetries: 3,
      temperature: 0.3,
      maxTokens: 4000,
    }),
    makeTaskConfig('coordinate-delegate', QUICK_CHEAP_MODELS, {
      timeoutMs: 10000,
      maxRetries: 2,
      temperature: 0.2,
    }),

    // Classification — very quick
    makeTaskConfig('classify-intent', QUICK_CHEAP_MODELS, {
      timeoutMs: 8000,
      maxRetries: 2,
      temperature: 0.1,
      maxTokens: 500,
    }),
    makeTaskConfig('classify-priority', QUICK_CHEAP_MODELS, {
      timeoutMs: 8000,
      maxRetries: 2,
      temperature: 0.1,
      maxTokens: 500,
    }),

    // Summarization — balanced
    makeTaskConfig('summarize-chat', BALANCED_MODELS, {
      timeoutMs: 20000,
      maxRetries: 2,
      temperature: 0.3,
    }),
    makeTaskConfig('summarize-thread', BALANCED_MODELS, {
      timeoutMs: 25000,
      maxRetries: 2,
      temperature: 0.3,
      maxTokens: 3000,
    }),

    // Extraction — strong for reliability
    makeTaskConfig('extract-entities', BALANCED_MODELS, {
      timeoutMs: 20000,
      maxRetries: 3,
      temperature: 0.1,
    }),

    // Tag generation — quick
    makeTaskConfig('generate-tags', QUICK_CHEAP_MODELS, {
      timeoutMs: 10000,
      maxRetries: 2,
      temperature: 0.3,
      maxTokens: 1000,
    }),

    // Response drafting — stronger
    makeTaskConfig('draft-response', BALANCED_MODELS, {
      timeoutMs: 25000,
      maxRetries: 3,
      temperature: 0.5,
      maxTokens: 4000,
    }),

    // Reflection — strong for quality
    makeTaskConfig('reflect-check', STRONG_MODELS, {
      timeoutMs: 30000,
      maxRetries: 3,
      temperature: 0.2,
      maxTokens: 3000,
    }),

    // Coding tasks
    makeTaskConfig('code-generate', CODING_MODELS, {
      timeoutMs: 60000,
      maxRetries: 3,
      temperature: 0.2,
      maxTokens: 8000,
    }),
    makeTaskConfig('code-review', BALANCED_MODELS, {
      timeoutMs: 30000,
      maxRetries: 2,
      temperature: 0.3,
      maxTokens: 4000,
    }),
  ];
}

/**
 * Build configs with auto-selection applied.
 * Only includes models for which API keys are available.
 */
export function getAutoSelectedTaskConfigs(): LiteLLMTaskConfig[] {
  const configs = getDefaultTaskConfigs();
  return configs.map((cfg) => ({
    ...cfg,
    models: cfg.strategy === 'auto' ? autoSelectModels(cfg.models) : cfg.models,
  }));
}
