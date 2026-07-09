import { describe, it, expect } from 'vitest';
import { LiteLLMClient, BaseTool, objectParam, stringParam } from '../../src/litellm/contract';

/** Sample tool for testing */
class WeatherTool extends BaseTool {
  readonly name = 'get_weather';
  readonly description = 'Get current weather for a city';
  readonly parameters = objectParam({ city: stringParam('City name') }, ['city']);

  async execute(args: Record<string, unknown>): Promise<string> {
    return `Weather in ${args.city}: sunny, 22°C`;
  }
}

describe('Tool system', () => {
  it('should register BaseTool instances in ToolRegistry', () => {
    const client = new LiteLLMClient();
    const tool = new WeatherTool();
    client.tools.register(tool);

    expect(client.tools.has('get_weather')).toBe(true);
    expect(client.tools.getSchema('get_weather')).toBeDefined();
    expect(client.tools.getHandler('get_weather')).toBeDefined();
  });

  it('should execute a registered tool handler', async () => {
    const client = new LiteLLMClient();
    client.tools.register(new WeatherTool());

    const handler = client.tools.getHandler('get_weather')!;
    expect(handler).toBeDefined();

    const result = await handler({ city: 'Berlin' });
    expect(result).toContain('Berlin');
    expect(result).toContain('sunny');
  });

  it('should produce valid AI SDK-compatible schemas', () => {
    const tool = new WeatherTool();
    const schema = tool.toSchema();

    expect(schema.type).toBe('function');
    expect(schema.function.name).toBe('get_weather');
    expect(schema.function.description).toBe('Get current weather for a city');
    expect(schema.function.parameters).toHaveProperty('type', 'object');
  });

  it('should list all registered tools', () => {
    const client = new LiteLLMClient();
    client.tools.register(new WeatherTool());
    client.tools.registerAdHoc(
      'query_db',
      'Query the database',
      { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] },
      (args) => `Results for: ${args.sql}`,
    );

    expect(client.tools.list()).toContain('get_weather');
    expect(client.tools.list()).toContain('query_db');
  });

  it('should require tools for completeWithTools when maxRounds > 1', async () => {
    const client = new LiteLLMClient();
    client.modelPool.withConfig({
      task: 'memory-compact',
      models: [{ provider: 'openai', model: 'gpt-4o-mini', order: 1 }],
    });

    await expect(
      client.completeWithTools(
        {
          task: 'memory-compact',
          messages: [{ role: 'user', content: 'Hello' }],
        },
        undefined,
        5,
      ),
    ).rejects.toThrow('completeWithTools requires tools');
  });
});
