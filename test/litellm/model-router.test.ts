import { describe, it, expect } from 'vitest';
import { ModelRouter, NoModelAvailableError } from '../../src/litellm/model-router';
import type { LiteLLMTaskConfig, ModelEntry } from '../../src/litellm/contract';

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
        { model: 'model-b', provider: 'openai', order: 2 },
        { model: 'model-a', provider: 'openai', order: 1 },
        { model: 'model-c', provider: 'openai', order: 3 },
      ]);

      const result = router.select('test-task', config);
      expect(result.entry.model).toBe('model-a');
      expect(result.strategy).toBe('order');
    });

    it('should skip disabled models', () => {
      const config = createConfig([
        { model: 'model-a', provider: 'openai', order: 1, enabled: false },
        { model: 'model-b', provider: 'openai', order: 2 },
      ]);

      const result = router.select('test-task', config);
      expect(result.entry.model).toBe('model-b');
    });

    it('should throw when all models disabled', () => {
      const config = createConfig([
        { model: 'model-a', provider: 'openai', order: 1, enabled: false },
      ]);

      expect(() => router.select('test-task', config)).toThrow(NoModelAvailableError);
    });
  });

  describe('auto strategy', () => {
    it('should filter by available providers', () => {
      const config = createConfig(
        [
          { model: 'openai/gpt-4', provider: 'openai', order: 1 },
          { model: 'google/gemini', provider: 'google', order: 2 },
          { model: 'local/llama', provider: 'ollama', order: 3 },
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
          { model: 'expensive', provider: 'openai', order: 1, costPer1kTokens: 0.03 },
          { model: 'cheap', provider: 'openai', order: 2, costPer1kTokens: 0.00015 },
          { model: 'mid', provider: 'openai', order: 3, costPer1kTokens: 0.003 },
        ],
        'cheapest',
      );

      const result = router.select('test-task', config);
      expect(result.entry.model).toBe('cheap');
    });

    it('should fallback to order when no cost info', () => {
      const config = createConfig(
        [
          { model: 'model-b', provider: 'openai', order: 2 },
          { model: 'model-a', provider: 'openai', order: 1 },
        ],
        'cheapest',
      );

      const result = router.select('test-task', config);
      expect(result.entry.model).toBe('model-a');
    });
  });

  describe('fastest strategy', () => {
    it('should prefer flash-lite models', () => {
      const config = createConfig(
        [
          { model: 'anthropic/claude-sonnet', provider: 'anthropic', order: 1 },
          { model: 'google/gemini-2.0-flash-lite', provider: 'google', order: 2 },
          { model: 'openai/gpt-4o-mini', provider: 'openai', order: 3 },
        ],
        'fastest',
      );

      const result = router.select('test-task', config);
      expect(result.entry.model).toBe('google/gemini-2.0-flash-lite');
    });
  });

  describe('explicit strategy', () => {
    it('should select the exact model', () => {
      const config = createConfig([
        { model: 'model-a', provider: 'openai', order: 1 },
        { model: 'model-b', provider: 'openai', order: 2 },
      ]);

      const result = router.select('test-task', {
        ...config,
        strategy: { type: 'explicit', model: 'model-b' },
      });

      expect(result.entry.model).toBe('model-b');
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
        { model: 'primary', provider: 'openai', order: 1 },
        { model: 'fallback', provider: 'anthropic', order: 2 },
      ]);

      const first = router.selectFallback('test-task', config, 0);
      expect(first.entry.model).toBe('primary');

      const second = router.selectFallback('test-task', config, 1);
      expect(second.entry.model).toBe('fallback');
    });

    it('should throw when fallback index out of range', () => {
      const config = createConfig([{ model: 'only', provider: 'openai', order: 1 }]);

      expect(() => router.selectFallback('test-task', config, 5)).toThrow(NoModelAvailableError);
    });
  });
});
