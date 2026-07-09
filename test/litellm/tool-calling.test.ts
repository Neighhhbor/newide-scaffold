import { describe, it, expect, vi } from 'vitest';
import { LiteLLMClient, getDefaultTaskConfigs } from '../../src/litellm/contract';

/**
 * End-to-end tool-calling simulation.
 *
 * Mocks the LiteLLM proxy so the model responds with a tool_call in round 1
 * and a plain text answer in round 2. The test verifies the tool handler was
 * invoked with the LLM-supplied arguments.
 */

function makeMockResponse(choice: {
  content?: string;
  tool_calls?: Array<{
    id: string;
    function: { name: string; arguments: string };
  }>;
  finish_reason?: string;
}) {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-mock',
      model: 'gpt-4o-mini',
      choices: [
        {
          message: { role: 'assistant', ...choice },
          finish_reason: choice.finish_reason ?? 'stop',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

describe('Tool calling (simulated)', () => {
  it('should invoke a registered tool when the model returns a tool_call', async () => {
    // ── 1. Set up the mock tool handler ──
    const weatherHandler = vi.fn(async (args: Record<string, unknown>) => {
      return `Weather in ${args.city}: sunny, 22°C`;
    });

    // ── 2. Mock fetch: round 1 → tool_call, round 2 → final answer ──
    const fetch = vi
      .fn()
      // Round 1: model decides to call get_weather
      .mockResolvedValueOnce(
        makeMockResponse({
          content: '',
          tool_calls: [
            {
              id: 'call_1',
              function: { name: 'get_weather', arguments: '{"city":"Berlin"}' },
            },
          ],
          finish_reason: 'tool_calls',
        }),
      )
      // Round 2: model sees the tool result and produces final answer
      .mockResolvedValueOnce(
        makeMockResponse({
          content: 'The weather in Berlin is sunny with 22°C.',
        }),
      );

    // ── 3. Build the client ──
    const client = new LiteLLMClient({
      baseUrl: 'http://mock-proxy:4000',
      apiKey: 'sk-mock',
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    client.modelPool.withConfigs(getDefaultTaskConfigs());
    client.tools.registerAdHoc(
      'get_weather',
      'Get current weather for a city',
      {
        type: 'object',
        properties: { city: { type: 'string', description: 'City name' } },
        required: ['city'],
      },
      weatherHandler,
    );

    // ── 4. Execute tool-calling loop ──
    const result = await client.completeWithTools(
      {
        task: 'memory-compact',
        messages: [{ role: 'user', content: "What's the weather in Berlin?" }],
      },
      undefined, // use registered tools
      5, // max rounds
    );

    // ── 5. Assertions ──
    // Tool handler was called exactly once
    expect(weatherHandler).toHaveBeenCalledOnce();
    expect(weatherHandler).toHaveBeenCalledWith({ city: 'Berlin' });

    // Final response comes from the second mock
    expect(result.content).toBe('The weather in Berlin is sunny with 22°C.');
    expect(result.toolCalls).toHaveLength(0);
    expect(result.finishReason).toBe('stop');

    // fetch was called twice (round 1 + round 2)
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('should handle unknown tools gracefully', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(
      makeMockResponse({
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            function: { name: 'nonexistent_tool', arguments: '{}' },
          },
        ],
        finish_reason: 'tool_calls',
      }),
    );

    // Second round: model reacts to the tool error
    fetch.mockResolvedValueOnce(makeMockResponse({ content: "Sorry, I can't do that." }));

    const client = new LiteLLMClient({
      baseUrl: 'http://mock-proxy:4000',
      apiKey: 'sk-mock',
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    client.modelPool.withConfigs(getDefaultTaskConfigs());
    // Register a dummy tool so completeWithTools doesn't bail early
    client.tools.registerAdHoc(
      'dummy',
      'A placeholder tool',
      { type: 'object', properties: {}, required: [] },
      () => 'ok',
    );

    const result = await client.completeWithTools(
      {
        task: 'memory-compact',
        messages: [{ role: 'user', content: 'Do something impossible.' }],
      },
      undefined,
      5,
    );

    // Should complete without throwing — the tool error is returned to the model
    expect(result.content).toBe("Sorry, I can't do that.");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
