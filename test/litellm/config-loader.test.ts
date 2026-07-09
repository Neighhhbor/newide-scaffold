import { describe, it, expect, afterAll } from 'vitest';
import { writeFileSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLitellmConfig } from '../../src/litellm/contract';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMP = resolve(__dirname, '__tmp-litellm-config.yaml');

afterAll(() => {
  try {
    unlinkSync(TMP);
  } catch {
    /* ok */
  }
});

describe('loadLitellmConfig', () => {
  it('should parse a minimal YAML config into typed task configs', () => {
    const yaml = `
defaults:
  timeoutMs: 30000
  maxRetries: 3
  temperature: 0.3
  maxTokens: 2000

tasks:
  memory-query:
    strategy: order
    timeoutMs: 10000
    models:
      - litellmModel: openai/gpt-4o-mini
        provider: openai
        order: 1
      - litellmModel: anthropic/claude-haiku
        provider: anthropic
        order: 2

  classify-intent:
    strategy: cheapest
    maxTokens: 500
    models:
      - litellmModel: openai/gpt-4o-mini
        provider: openai
        order: 1
        costPer1kTokens: 0.00015
      - litellmModel: google/gemini-flash
        provider: google
        order: 2
        costPer1kTokens: 0.0001
`;
    writeFileSync(TMP, yaml, 'utf-8');

    const { defaults, tasks } = loadLitellmConfig(TMP);

    // defaults
    expect(defaults.timeoutMs).toBe(30000);
    expect(defaults.maxRetries).toBe(3);

    // tasks
    expect(tasks).toHaveLength(2);

    const query = tasks.find((t) => t.task === 'memory-query')!;
    expect(query).toBeDefined();
    expect(query.strategy).toBe('order');
    expect(query.timeoutMs).toBe(10000);
    expect(query.models).toHaveLength(2);
    expect(query.models[0]!.litellmModel).toBe('openai/gpt-4o-mini');
    expect(query.models[0]!.provider).toBe('openai');
    expect(query.models[1]!.litellmModel).toBe('anthropic/claude-haiku');

    const cls = tasks.find((t) => t.task === 'classify-intent')!;
    expect(cls.strategy).toBe('cheapest');
    expect(cls.maxTokens).toBe(500);
    expect(cls.timeoutMs).toBeUndefined(); // not set → inherits default
  });

  it('should load the built-in litellm-config.yaml without errors', () => {
    const { defaults, tasks } = loadLitellmConfig(); // default path

    expect(defaults.timeoutMs).toBeGreaterThan(0);
    expect(tasks.length).toBeGreaterThanOrEqual(10);
    // Every task should have at least one model
    for (const t of tasks) {
      expect(t.models.length).toBeGreaterThan(0);
      expect(t.task).toBeTruthy();
    }
  });
});
