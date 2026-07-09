import { describe, it, expect, beforeEach } from 'vitest';
import { MethodRegistry, BaseMethod } from '../../src/litellm/contract';
import type { MethodContext, MethodResult } from '../../src/litellm/contract';

class MockMethod extends BaseMethod {
  readonly name = 'mock_method';
  readonly description = 'A mock method';
  readonly task = 'test-task';

  execute(_ctx: MethodContext, params: Record<string, unknown>): MethodResult {
    return { content: `executed with ${JSON.stringify(params)}` };
  }
}

class AnotherMethod extends BaseMethod {
  readonly name = 'another_method';
  readonly description = 'Another mock method';
  readonly task = 'another-task';

  execute(): MethodResult {
    return { content: 'another' };
  }
}

describe('MethodRegistry', () => {
  let registry: MethodRegistry;

  beforeEach(() => {
    registry = new MethodRegistry();
  });

  it('should register and retrieve a method', () => {
    const method = new MockMethod();
    registry.register(method);

    expect(registry.has('mock_method')).toBe(true);
    expect(registry.get('mock_method')).toBe(method);
  });

  it('should throw on duplicate registration', () => {
    registry.register(new MockMethod());
    expect(() => registry.register(new MockMethod())).toThrow('already registered');
  });

  it('should register multiple methods', () => {
    registry.registerAll([new MockMethod(), new AnotherMethod()]);

    expect(registry.list()).toEqual(['mock_method', 'another_method']);
  });

  it('should unregister a method', () => {
    registry.register(new MockMethod());
    expect(registry.unregister('mock_method')).toBe(true);
    expect(registry.has('mock_method')).toBe(false);
  });

  it('should find methods by task', () => {
    registry.registerAll([new MockMethod(), new AnotherMethod()]);

    const found = registry.findByTask('test-task');
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe('mock_method');
  });

  it('should get all handlers', () => {
    registry.registerAll([new MockMethod(), new AnotherMethod()]);

    const all = registry.getAll();
    expect(all).toHaveLength(2);
  });

  it('should clear all methods', () => {
    registry.registerAll([new MockMethod(), new AnotherMethod()]);
    registry.clear();
    expect(registry.list()).toHaveLength(0);
  });
});
