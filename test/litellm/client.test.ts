import { describe, it, expect } from 'vitest';
import { LiteLLMClient } from '../../src/litellm/contract';

describe('LiteLLMClient', () => {
  it('should initialize with required subsystems', () => {
    const client = new LiteLLMClient();
    expect(client.modelPool).toBeDefined();
    expect(client.methods).toBeDefined();
    expect(client.tools).toBeDefined();
  });

  it('should load config via loadConfig()', () => {
    const client = new LiteLLMClient();
    client.loadConfig(); // loads bundled config/ directory
    expect(client.modelPool.canHandle('classify-intent')).toBe(true);
    expect(client.modelPool.canHandle('memory-query')).toBe(true);
    expect(client.modelPool.canHandle('extract-entities')).toBe(true);
  });

  it('should register custom methods', () => {
    const client = new LiteLLMClient();
    const customMethod = {
      name: 'custom_method',
      description: 'A custom method',
      task: 'custom-task',
      execute: () => ({ content: 'custom result' }),
    };

    const returned = client.registerMethod(customMethod);
    expect(returned).toBe(client);
    expect(client.methods.canCall('custom_method')).toBe(true);
  });

  it('should register custom tools via constructor options', () => {
    const client = new LiteLLMClient({
      tools: {
        my_tool: () => 'ok',
      },
    });
    expect(client.tools.has('my_tool')).toBe(true);
  });

  it('should throw on unknown task for complete()', async () => {
    const client = new LiteLLMClient();
    await expect(
      client.complete({
        task: 'nonexistent-task',
        messages: [{ role: 'user', content: 'test' }],
      }),
    ).rejects.toThrow('No model configuration');
  });

  it('should reject completeWithTools when no tools available', async () => {
    const client = new LiteLLMClient();
    client.modelPool.withConfig({
      task: 'memory-compact',
      models: [{ provider: 'openai', model: 'gpt-4o-mini', order: 1 }],
    });
    await expect(
      client.completeWithTools({
        task: 'memory-compact',
        messages: [{ role: 'user', content: 'test' }],
      }),
    ).rejects.toThrow('completeWithTools requires tools');
  });
});
