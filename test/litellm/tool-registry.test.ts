import { describe, it, expect, beforeEach } from 'vitest';
import { ToolRegistry, BaseTool } from '../../src/litellm/contract';

// Mock tool for testing
class MockTool extends BaseTool {
  readonly name = 'mock_tool';
  readonly description = 'A mock tool for testing';
  readonly parameters = {
    type: 'object' as const,
    properties: {
      input: { type: 'string', description: 'Input value' },
    },
    required: ['input'],
  };

  execute(args: Record<string, unknown>): string {
    return `result: ${args.input}`;
  }
}

class AnotherTool extends BaseTool {
  readonly name = 'another_tool';
  readonly description = 'Another mock tool';
  readonly parameters = {
    type: 'object' as const,
    properties: {},
    required: [],
  };

  execute(): string {
    return 'another result';
  }
}

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it('should register a BaseTool instance', () => {
    const tool = new MockTool();
    registry.register(tool);

    expect(registry.has('mock_tool')).toBe(true);
    expect(registry.getSchema('mock_tool')).toEqual(tool.toSchema());
  });

  it('should execute a registered tool', async () => {
    const tool = new MockTool();
    registry.register(tool);

    const handler = registry.getHandler('mock_tool');
    expect(handler).toBeDefined();

    const result = await handler!({ input: 'hello' });
    expect(result).toBe('result: hello');
  });

  it('should register ad-hoc tool', () => {
    registry.registerAdHoc(
      'adhoc_tool',
      'An ad-hoc tool',
      { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] },
      (args) => `x=${args.x}`,
    );

    expect(registry.has('adhoc_tool')).toBe(true);
    const handler = registry.getHandler('adhoc_tool');
    expect(handler!({ x: 42 })).toBe('x=42');
  });

  it('should register multiple tools', () => {
    registry.registerAll([new MockTool(), new AnotherTool()]);

    expect(registry.list()).toContain('mock_tool');
    expect(registry.list()).toContain('another_tool');
  });

  it('should return all schemas', () => {
    registry.registerAll([new MockTool(), new AnotherTool()]);

    const schemas = registry.getAllSchemas();
    expect(schemas).toHaveLength(2);
    expect(schemas.map((s) => s.function.name)).toContain('mock_tool');
    expect(schemas.map((s) => s.function.name)).toContain('another_tool');
  });

  it('should return all handlers', () => {
    registry.registerAll([new MockTool(), new AnotherTool()]);

    const handlers = registry.getAllHandlers();
    expect(Object.keys(handlers)).toHaveLength(2);
    expect(handlers.mock_tool).toBeDefined();
    expect(handlers.another_tool).toBeDefined();
  });

  it('should unregister a tool', () => {
    registry.register(new MockTool());
    expect(registry.unregister('mock_tool')).toBe(true);
    expect(registry.has('mock_tool')).toBe(false);
  });

  it('should merge with another registry', () => {
    const r1 = new ToolRegistry();
    r1.register(new MockTool());

    const r2 = new ToolRegistry();
    r2.register(new AnotherTool());

    r1.merge(r2);

    expect(r1.has('mock_tool')).toBe(true);
    expect(r1.has('another_tool')).toBe(true);
  });

  it('should return undefined for unknown tool', () => {
    expect(registry.getSchema('unknown')).toBeUndefined();
    expect(registry.getHandler('unknown')).toBeUndefined();
  });

  it('should clear all tools', () => {
    registry.registerAll([new MockTool(), new AnotherTool()]);
    registry.clear();
    expect(registry.list()).toHaveLength(0);
  });
});
