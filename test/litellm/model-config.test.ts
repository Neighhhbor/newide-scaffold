import { describe, it, expect, beforeEach } from 'vitest';
import { ModelConfigManager } from '../../src/litellm/model-config';
import type { LiteLLMTaskConfig, ModelEntry } from '../../src/litellm/types';

const mockModels: ModelEntry[] = [
  { litellmModel: 'openai/gpt-4o-mini', provider: 'openai', order: 1 },
  { litellmModel: 'anthropic/claude-haiku', provider: 'anthropic', order: 2 },
];

const mockConfig: LiteLLMTaskConfig = {
  task: 'memory-compact',
  models: mockModels,
  strategy: 'order',
  timeoutMs: 15000,
  maxRetries: 2,
};

describe('ModelConfigManager', () => {
  let manager: ModelConfigManager;

  beforeEach(() => {
    manager = new ModelConfigManager();
  });

  it('should register and retrieve a config', () => {
    manager.register(mockConfig);
    expect(manager.get('memory-compact')).toEqual(mockConfig);
  });

  it('should register multiple configs', () => {
    const cfg2: LiteLLMTaskConfig = {
      task: 'coordinate-plan',
      models: mockModels,
      strategy: 'auto',
    };
    manager.registerAll([mockConfig, cfg2]);

    expect(manager.get('memory-compact')).toEqual(mockConfig);
    expect(manager.get('coordinate-plan')).toEqual(cfg2);
  });

  it('should check if a task is configured', () => {
    expect(manager.has('memory-compact')).toBe(false);
    manager.register(mockConfig);
    expect(manager.has('memory-compact')).toBe(true);
  });

  it('should return undefined for unknown tasks', () => {
    expect(manager.get('unknown-task')).toBeUndefined();
  });

  it('should unregister a config', () => {
    manager.register(mockConfig);
    expect(manager.unregister('memory-compact')).toBe(true);
    expect(manager.get('memory-compact')).toBeUndefined();
  });

  it('should return false when unregistering unknown task', () => {
    expect(manager.unregister('unknown')).toBe(false);
  });

  it('should list all registered tasks', () => {
    manager.register(mockConfig);
    manager.register({ ...mockConfig, task: 'classify-intent' });
    expect(manager.getTasks()).toEqual(['memory-compact', 'classify-intent']);
  });

  it('should update strategy', () => {
    manager.register(mockConfig);
    expect(manager.setStrategy('memory-compact', 'auto')).toBe(true);
    expect(manager.get('memory-compact')?.strategy).toBe('auto');
  });

  it('should return false when updating unknown task', () => {
    expect(manager.setStrategy('unknown', 'auto')).toBe(false);
  });

  it('should update timeout', () => {
    manager.register(mockConfig);
    expect(manager.setTimeout('memory-compact', 5000)).toBe(true);
    expect(manager.get('memory-compact')?.timeoutMs).toBe(5000);
  });

  it('should update max retries', () => {
    manager.register(mockConfig);
    expect(manager.setMaxRetries('memory-compact', 5)).toBe(true);
    expect(manager.get('memory-compact')?.maxRetries).toBe(5);
  });

  it('should update model entries', () => {
    manager.register(mockConfig);
    const newModels: ModelEntry[] = [
      { litellmModel: 'google/gemini-flash', provider: 'google', order: 1 },
    ];
    expect(manager.setModels('memory-compact', newModels)).toBe(true);
    expect(manager.get('memory-compact')?.models).toEqual(newModels);
  });
});
