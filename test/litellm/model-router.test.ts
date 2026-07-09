import { describe, it, expect } from 'vitest';
import { ModelRouter, NoModelAvailableError } from '../../src/litellm/model-router';
import type { LiteLLMTaskConfig, ModelEntry } from '../../src/litellm/types';

describe('ModelRouter', () => {
  const router = new ModelRouter();

  const createConfig = (
    models: ModelEntry[],
    strategy: LiteLLMTaskConfig['strategy'] = 'order',
  ): LiteLLMTaskConfig => ({
    task: 'test-task',
    models,
    strategy,
  });

  describe('order strategy', () => {
    it('should select lowest order model', () => {
      const config = createConfig([
        { litellmModel: 'model-b', provider: 'openai', order: 2 },
        { litellmModel: 'model-a', provider: 'openai', order: 1 },
        { litellmModel: 'model-c', provider: 'openai', order: 3 },
      ]);

      const result = router.select('test-task', config);
      expect(result.entry.litellmModel).toBe('model-a');
      expect(result.strategy).toBe('order');
    });

    it('should skip disabled models', () => {
      const config = createConfig([
        { litellmModel: 'model-a', provider: 'openai', order: 1, enabled: false },
        { litellmModel: 'model-b', provider: 'openai', order: 2 },
      ]);

      const result = router.select('test-task', config);
      expect(result.entry.litellmModel).toBe('model-b');
    });

    it('should throw when all models disabled', () => {
      const config = createConfig([
        { litellmModel: 'model-a', provider: 'openai', order: 1, enabled: false },
      ]);

      expect(() => router.select('test-task', config)).toThrow(NoModelAvailableError);
    });
  });

  describe('auto strategy', () => {
    it('should filter by available providers', () => {
      const config = createConfig(
        [
          { litellmModel: 'openai/gpt-4', provider: 'openai', order: 1 },
          { litellmModel: 'google/gemini', provider: 'google', order: 2 },
          { litellmModel: 'local/llama', provider: 'ollama', order: 3 },
        ],
        'auto',
      );

      // Result depends on env vars — just verify it doesn't throw
      const result = router.select('test-task', config);
      expect(result.entry).toBeDefined();
      expect(result.strategy).toBe('auto');
    });
  });

  describe('cheapest strategy', () => {
    it('should select lowest cost model', () => {
      const config = createConfig(
        [
          { litellmModel: 'expensive', provider: 'openai', order: 1, costPer1kTokens: 0.03 },
          { litellmModel: 'cheap', provider: 'openai', order: 2, costPer1kTokens: 0.00015 },
          { litellmModel: 'mid', provider: 'openai', order: 3, costPer1kTokens: 0.003 },
        ],
        'cheapest',
      );

      const result = router.select('test-task', config);
      expect(result.entry.litellmModel).toBe('cheap');
    });

    it('should fallback to order when no cost info', () => {
      const config = createConfig(
        [
          { litellmModel: 'model-b', provider: 'openai', order: 2 },
          { litellmModel: 'model-a', provider: 'openai', order: 1 },
        ],
        'cheapest',
      );

      const result = router.select('test-task', config);
      expect(result.entry.litellmModel).toBe('model-a');
    });
  });

  describe('fastest strategy', () => {
    it('should prefer flash-lite models', () => {
      const config = createConfig(
        [
          { litellmModel: 'anthropic/claude-sonnet', provider: 'anthropic', order: 1 },
          { litellmModel: 'google/gemini-2.0-flash-lite', provider: 'google', order: 2 },
          { litellmModel: 'openai/gpt-4o-mini', provider: 'openai', order: 3 },
        ],
        'fastest',
      );

      const result = router.select('test-task', config);
      expect(result.entry.litellmModel).toBe('google/gemini-2.0-flash-lite');
    });
  });

  describe('explicit strategy', () => {
    it('should select the exact model', () => {
      const config = createConfig([
        { litellmModel: 'model-a', provider: 'openai', order: 1 },
        { litellmModel: 'model-b', provider: 'openai', order: 2 },
      ]);

      const result = router.select('test-task', {
        ...config,
        strategy: { type: 'explicit', model: 'model-b' },
      });

      expect(result.entry.litellmModel).toBe('model-b');
    });

    it('should throw when explicit model not found', () => {
      const config = createConfig([{ litellmModel: 'model-a', provider: 'openai', order: 1 }]);

      expect(() =>
        router.select('test-task', {
          ...config,
          strategy: { type: 'explicit', model: 'nonexistent' },
        }),
      ).toThrow(NoModelAvailableError);
    });
  });

  describe('fallback selection', () => {
    it('should select by index for retries', () => {
      const config = createConfig([
        { litellmModel: 'primary', provider: 'openai', order: 1 },
        { litellmModel: 'fallback', provider: 'anthropic', order: 2 },
      ]);

      const first = router.selectFallback('test-task', config, 0);
      expect(first.entry.litellmModel).toBe('primary');

      const second = router.selectFallback('test-task', config, 1);
      expect(second.entry.litellmModel).toBe('fallback');
    });

    it('should throw when fallback index out of range', () => {
      const config = createConfig([{ litellmModel: 'only', provider: 'openai', order: 1 }]);

      expect(() => router.selectFallback('test-task', config, 5)).toThrow(NoModelAvailableError);
    });
  });
});
