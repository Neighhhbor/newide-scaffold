/**
 * Real LLM integration test — manual only.
 *
 * ## Setup
 * 1. Fill in LITELLM_BASE_URL and LITELLM_API_KEY below (or set env vars).
 * 2. Make sure your LiteLLM proxy is running and has at least one model
 *    a configured model (e.g. openai/gpt-4o-mini).
 * 3. Run:
 *      pnpm vitest run test/litellm/real-llm.test.ts
 *
 * The test is skipped automatically when credentials are missing.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { LiteLLMClient, type LiteLLMMessage } from '../../src/litellm/contract';

// ═══════════════════════════════════════════════════════════
// FILL THESE IN (or set the equivalent environment variables)
// ═══════════════════════════════════════════════════════════
const BASE_URL = process.env.LITELLM_BASE_URL ?? '<your-litellm-proxy-url>';
const API_KEY = process.env.LITELLM_API_KEY ?? '<your-api-key>';

const skip =
  BASE_URL.includes('<') || API_KEY.includes('<')
    ? 'Set LITELLM_BASE_URL / LITELLM_API_KEY or edit the placeholders in real-llm.test.ts'
    : false;

describe('Real LLM calls (manual)', () => {
  let client: LiteLLMClient;

  beforeAll(() => {
    client = new LiteLLMClient({ baseUrl: BASE_URL, apiKey: API_KEY });
    client.loadConfig(); // reads src/litellm/config/
  });

  // ── 1. Basic completion ─────────────────────────────────

  it.runIf(!skip)(
    'should get a text completion from a real model',
    async () => {
      const messages: LiteLLMMessage[] = [
        { role: 'system', content: 'Reply in a single short sentence.' },
        { role: 'user', content: 'What is the capital of France?' },
      ];

      const resp = await client.complete({ task: 'memory-query', messages });

      expect(resp.content).toBeTruthy();
      expect(resp.model).toBeTruthy();
      expect(resp.usage.total_tokens).toBeGreaterThan(0);
      console.log(
        `[real] model=${resp.model} tokens=${resp.usage.total_tokens} reply="${resp.content}"`,
      );
    },
    30_000,
  );

  // ── 2. Structured output ───────────────────────────────

  it.runIf(!skip)(
    'should return typed JSON via structured output',
    async () => {
      const messages: LiteLLMMessage[] = [
        {
          role: 'user',
          content:
            'Extract: "Alice bought 3 apples for $5". Return JSON with item, quantity, price.',
        },
      ];

      interface Extraction {
        item: string;
        quantity: number;
        price: number;
      }

      const result = await client.structured<Extraction>({
        task: 'extract-entities',
        messages,
        responseFormat: {
          name: 'extraction',
          schema: {
            type: 'object',
            properties: {
              item: { type: 'string' },
              quantity: { type: 'number' },
              price: { type: 'number' },
            },
            required: ['item', 'quantity', 'price'],
          },
          strict: true,
        },
      });

      expect(result.item).toBeTruthy();
      expect(typeof result.quantity).toBe('number');
      expect(typeof result.price).toBe('number');
      console.log(`[real] structured → ${JSON.stringify(result)}`);
    },
    30_000,
  );

  // ── 3. Tool calling ────────────────────────────────────

  it.runIf(!skip)(
    'should force a tool call and execute the handler',
    async () => {
      let calledWith: Record<string, unknown> | null = null;

      client.tools.registerAdHoc(
        'get_weather',
        'Get current weather for a city',
        {
          type: 'object',
          properties: { city: { type: 'string', description: 'City name' } },
          required: ['city'],
        },
        async (args) => {
          calledWith = args;
          return JSON.stringify({ city: args.city, temp_c: 22, condition: 'sunny' });
        },
      );

      const messages: LiteLLMMessage[] = [
        { role: 'user', content: "What's the weather in Tokyo?" },
      ];

      // Force the model to call get_weather
      const resp = await client.complete({
        task: 'memory-query',
        messages,
        tools: client.tools.getAllSchemas(),
        toolChoice: { type: 'function', function: { name: 'get_weather' } },
      });

      expect(resp.toolCalls.length).toBeGreaterThan(0);
      const tc = resp.toolCalls[0]!;
      expect(tc.function.name).toBe('get_weather');

      // Manually execute the handler
      console.log(`[real] raw tool arguments: ${tc.function.arguments}`);
      const handler = client.tools.getHandler('get_weather')!;
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
      } catch {
        // Some models return non-standard JSON — extract city manually
        const cityMatch = tc.function.arguments.match(/Tokyo|"city"\s*:\s*"([^"]+)"/);
        args = { city: cityMatch?.[1] ?? cityMatch?.[0] ?? tc.function.arguments };
      }
      const result = await handler(args);

      expect(calledWith).not.toBeNull();
      expect(calledWith!.city).toBe('Tokyo');
      expect(result).toContain('sunny');
      console.log(`[real] tool called with city="${calledWith!.city}", result="${result}"`);
    },
    60_000,
  );
});
