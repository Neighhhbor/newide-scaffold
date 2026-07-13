/**
 * Tool 抽象层测试
 *
 * 验证：
 *   1. ToolRegistry 注册/查询/列表
 *   2. toToolDefinitions 格式转换
 *   3. Tool 通用接口语义
 */
import { describe, it, expect } from 'vitest';
import { ToolRegistry, type Tool, type ToolDefinition } from '../runtime/tool';

describe('Tool', () => {
  it('Tool 接口可以正确定义和实现', async () => {
    const testTool: Tool<{ value: number }, string> = {
      name: 'test_tool',
      description: 'A test tool',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'number' } },
        required: ['value'],
      },
      execute: async (input) => `result: ${input.value}`,
    };

    expect(testTool.name).toBe('test_tool');
    expect(testTool.description).toBe('A test tool');
    expect(testTool.inputSchema).toBeDefined();
    expect(testTool.inputSchema.required).toContain('value');
  });

  it('Tool 的 execute 可以正常调用', async () => {
    const testTool: Tool<{ value: number }, string> = {
      name: 'test_tool',
      description: 'A test tool',
      inputSchema: { type: 'object', properties: {} },
      execute: async (input) => `result: ${input.value}`,
    };

    const result = await testTool.execute({ value: 42 });
    expect(result).toBe('result: 42');
  });
});

describe('ToolRegistry', () => {
  it('空注册表返回空列表', () => {
    const registry = new ToolRegistry();
    expect(registry.list()).toEqual([]);
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('通过构造函数注册工具', () => {
    const tool: Tool = {
      name: 'tool_a',
      description: 'Tool A',
      inputSchema: {},
      execute: async () => 'done',
    };
    const registry = new ToolRegistry([tool]);
    expect(registry.list()).toHaveLength(1);
    expect(registry.get('tool_a')).toBe(tool);
  });

  it('register 添加工具后 list/get 可用', () => {
    const registry = new ToolRegistry();
    const tool: Tool = {
      name: 'tool_b',
      description: 'Tool B',
      inputSchema: {},
      execute: async () => 'done',
    };
    registry.register(tool);
    expect(registry.list()).toHaveLength(1);
    expect(registry.get('tool_b')).toBe(tool);
  });

  it('注册同名工具会覆盖', () => {
    const registry = new ToolRegistry();
    const tool1: Tool = {
      name: 'dup',
      description: 'First',
      inputSchema: {},
      execute: async () => 'first',
    };
    const tool2: Tool = {
      name: 'dup',
      description: 'Second',
      inputSchema: {},
      execute: async () => 'second',
    };
    registry.register(tool1);
    registry.register(tool2);
    expect(registry.list()).toHaveLength(1);
    expect(registry.get('dup')).toBe(tool2);
  });

  it('toToolDefinitions 转换为正确的 OpenAI function-calling 格式', () => {
    const registry = new ToolRegistry([
      {
        name: 'query_memory',
        description: 'Search past experiences',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
        execute: async () => ({}),
      },
      {
        name: 'invoke_driver',
        description: 'Call a driver agent',
        inputSchema: {
          type: 'object',
          properties: { instruction: { type: 'string' } },
          required: ['instruction'],
        },
        execute: async () => ({}),
      },
    ]);

    const defs: ToolDefinition[] = registry.toToolDefinitions();
    expect(defs).toHaveLength(2);

    const queryDef = defs.find((d) => d.function.name === 'query_memory');
    expect(queryDef).toBeDefined();
    expect(queryDef!.type).toBe('function');
    expect(queryDef!.function.description).toBe('Search past experiences');
    expect(queryDef!.function.parameters.required).toContain('query');

    const driverDef = defs.find((d) => d.function.name === 'invoke_driver');
    expect(driverDef).toBeDefined();
    expect(driverDef!.function.description).toBe('Call a driver agent');
  });

  it('toToolDefinitions 空注册表返回空数组', () => {
    const registry = new ToolRegistry();
    expect(registry.toToolDefinitions()).toEqual([]);
  });
});
