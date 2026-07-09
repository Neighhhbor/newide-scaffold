import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LiteLLMClient, getDefaultTaskConfigs } from '../../src/litellm/contract';
import type { CompletionResponse, MethodHandler } from '../../src/litellm/types';

/** Create a mock fetch that returns a standard OpenAI-compatible response */
function createMockFetch(responseOverrides: Partial<CompletionResponse> = {}) {
  const defaultResponse: CompletionResponse = {
    id: 'chatcmpl-test-123',
    model: 'gpt-4o-mini',
    content: 'Test response content',
    toolCalls: [],
    usage: { prompt_tokens: 50, completion_tokens: 25, total_tokens: 75 },
    finishReason: 'stop',
  };

  return vi.fn(async () => {
    return new Response(
      JSON.stringify({
        id: responseOverrides.id ?? defaultResponse.id,
        model: responseOverrides.model ?? defaultResponse.model,
        choices: [
          {
            message: {
              role: 'assistant',
              content: responseOverrides.content ?? defaultResponse.content,
              tool_calls: responseOverrides.toolCalls ?? defaultResponse.toolCalls,
            },
            finish_reason: responseOverrides.finishReason ?? defaultResponse.finishReason,
          },
        ],
        usage: responseOverrides.usage ?? defaultResponse.usage,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  });
}

describe('LiteLLMClient', () => {
  let client: LiteLLMClient;
  let mockFetch: ReturnType<typeof createMockFetch>;

  beforeEach(() => {
    mockFetch = createMockFetch();
    client = new LiteLLMClient({
      baseUrl: 'http://test-proxy:4000',
      apiKey: 'sk-test-key',
      fetch: mockFetch as unknown as typeof fetch,
    });

    // Register model configs
    client.modelPool.withConfigs(getDefaultTaskConfigs());
  });

  it('should initialize with correct config', () => {
    expect(client.modelPool).toBeDefined();
    expect(client.methods).toBeDefined();
    expect(client.tools).toBeDefined();
    expect(client.audit).toBeDefined();
    expect(client.pool).toBeDefined();
  });

  it('should resolve API key from options', () => {
    expect(client).toBeDefined();
  });

  it('should send correct HTTP request', async () => {
    await client.complete({
      task: 'memory-compact',
      messages: [
        { role: 'system', content: 'You are a memory assistant' },
        { role: 'user', content: 'Compact my memories' },
      ],
    });

    expect(mockFetch).toHaveBeenCalledOnce();

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test-proxy:4000/v1/chat/completions');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)?.Authorization).toBe('Bearer sk-test-key');

    const body = JSON.parse(init?.body as string);
    expect(body.model).toBe('openai/gpt-4o-mini'); // order=1 from preset
    expect(body.messages).toHaveLength(2);
    expect(body.temperature).toBeDefined();
    expect(body.max_tokens).toBeDefined();
  });

  it('should parse completion response', async () => {
    mockFetch = createMockFetch({
      content: 'Here is your compacted memory summary',
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    });

    client = new LiteLLMClient({
      baseUrl: 'http://test-proxy:4000',
      apiKey: 'sk-test',
      fetch: mockFetch as unknown as typeof fetch,
    });
    client.modelPool.withConfigs(getDefaultTaskConfigs());

    const response = await client.complete({
      task: 'memory-compact',
      messages: [{ role: 'user', content: 'test' }],
    });

    expect(response.content).toBe('Here is your compacted memory summary');
    expect(response.usage.total_tokens).toBe(150);
    expect(response.finishReason).toBe('stop');
  });

  it('should handle structured output', async () => {
    mockFetch = createMockFetch({
      content: JSON.stringify({ summary: 'test', key_facts: ['fact1'] }),
    });

    client = new LiteLLMClient({
      baseUrl: 'http://test-proxy:4000',
      apiKey: 'sk-test',
      fetch: mockFetch as unknown as typeof fetch,
    });
    client.modelPool.withConfigs(getDefaultTaskConfigs());

    interface Result {
      summary: string;
      key_facts: string[];
    }

    const result = await client.structured<Result>({
      task: 'memory-compact',
      messages: [{ role: 'user', content: 'test' }],
      responseFormat: {
        name: 'memory_result',
        schema: {
          type: 'object',
          properties: {
            summary: { type: 'string' },
            key_facts: { type: 'array', items: { type: 'string' } },
          },
          required: ['summary', 'key_facts'],
        },
      },
    });

    expect(result.summary).toBe('test');
    expect(result.key_facts).toEqual(['fact1']);
  });

  it('should include tools in request body', async () => {
    client.tools.registerAdHoc(
      'test_tool',
      'A test tool',
      { type: 'object', properties: {}, required: [] },
      () => 'test result',
    );

    await client.complete({
      task: 'memory-compact',
      messages: [{ role: 'user', content: 'test' }],
      tools: client.tools.getAllSchemas(),
    });

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init?.body as string);
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].function.name).toBe('test_tool');
    expect(body.tool_choice).toBe('auto');
  });

  it('should throw on unknown task', async () => {
    await expect(
      client.complete({
        task: 'nonexistent-task',
        messages: [{ role: 'user', content: 'test' }],
      }),
    ).rejects.toThrow('No model configuration');
  });

  it('should support useDefaults() fluent API', () => {
    const c = new LiteLLMClient({
      baseUrl: 'http://test:4000',
      apiKey: 'sk-test',
      fetch: mockFetch as unknown as typeof fetch,
    });

    const returned = c.useDefaults();
    expect(returned).toBe(c);
    expect(c.modelPool.canHandle('memory-compact')).toBe(true);
    expect(c.modelPool.canHandle('coordinate-plan')).toBe(true);
  });

  it('should support enableMemoryAudit()', () => {
    const c = new LiteLLMClient({
      baseUrl: 'http://test:4000',
      apiKey: 'sk-test',
      fetch: mockFetch as unknown as typeof fetch,
    });
    c.modelPool.withConfigs(getDefaultTaskConfigs());

    const { sink, client: returnedClient } = c.enableMemoryAudit();
    expect(returnedClient).toBe(c);
    expect(sink).toBeDefined();
  });

  it('should retry on retryable HTTP errors', async () => {
    let callCount = 0;
    const retryFetch = vi.fn(async () => {
      callCount++;
      if (callCount < 3) {
        return new Response('Rate limited', { status: 429 });
      }
      return new Response(
        JSON.stringify({
          id: 'ok',
          model: 'm',
          choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const c = new LiteLLMClient({
      baseUrl: 'http://test:4000',
      apiKey: 'sk-test',
      fetch: retryFetch as unknown as typeof fetch,
    });
    c.modelPool.withConfigs(getDefaultTaskConfigs());

    const result = await c.complete({
      task: 'memory-compact',
      messages: [{ role: 'user', content: 'test' }],
    });

    expect(callCount).toBe(3);
    expect(result.content).toBe('ok');
  });

  it('should register custom methods', () => {
    const customMethod = {
      name: 'custom_method',
      description: 'A custom method',
      task: 'custom-task',
      execute: () => ({ content: 'custom result' }),
    };

    const returned = client.registerMethod(customMethod as unknown as MethodHandler);
    expect(returned).toBe(client);
    expect(client.methods.canCall('custom_method')).toBe(true);
  });
});
