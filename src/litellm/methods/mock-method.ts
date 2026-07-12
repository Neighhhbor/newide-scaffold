/**
 * ================================================
 * Mock Method Templates
 * ================================================
 *
 * All methods extend the same BaseMethod class.
 * In `execute()`, use `context` directly — combine
 * completion, tool-calling, and structured output freely.
 *
 * ── To add a new method ──
 * 1. Copy a template below into a new file in this directory.
 * 2. Set `name`, `description`, `task`.
 * 3. Declare tools: `readonly tools = [new WeatherTool()]` (see mock-tool.ts).
 * 4. Implement `execute(context, params)`.
 * 5. Create `config/<task>.yaml` with `profile: cheap` (or inline models).
 * 6. Register: `client.registerMethod(new MyMethod())`.
 */

import type { MethodContext, MethodResult, LiteLLMMessage } from '../contract';
import { BaseMethod } from './method-interface';
import { WeatherTool } from '../tools/mock-tool';

/* ═══════════════════════════════════════════════════════════
 * Template A: Simple Completion
 * ═══════════════════════════════════════════════════════════ */

export class MySimpleMethod extends BaseMethod {
  readonly name = 'my-simple';
  readonly description = 'A simple method that sends a prompt and returns text';
  readonly task = 'classify-intent';
  override readonly defaultProfile = 'cheap';

  async execute(context: MethodContext, params: Record<string, unknown>): Promise<MethodResult> {
    const messages: LiteLLMMessage[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: String(params.input) },
    ];
    const response = await context.complete(this.buildRequest(messages));
    return this.ok(response.content);
  }
}

/* ═══════════════════════════════════════════════════════════
 * Template B: Tool Calling
 *
 * Declare tools as instances. Use context.completeWithTools()
 * with this.getToolSchemas() and this.getToolHandlers().
 * ═══════════════════════════════════════════════════════════ */

export class MyToolMethod extends BaseMethod {
  readonly name = 'my-tool-method';
  readonly description = 'A method that lets the LLM call tools';
  readonly task = 'memory-query';
  override readonly tools = [new WeatherTool()];

  async execute(context: MethodContext, params: Record<string, unknown>): Promise<MethodResult> {
    const messages: LiteLLMMessage[] = [
      {
        role: 'system',
        content: 'You are a weather assistant. Use get_weather to check conditions.',
      },
      { role: 'user', content: String(params.query) },
    ];

    const response = await context.completeWithTools(
      this.buildRequest(messages),
      this.getToolHandlers(),
      /* maxRounds */ 5,
    );

    return { content: response.content, usage: response.usage };
  }
}

/* ═══════════════════════════════════════════════════════════
 * Template C: Structured Output
 *
 * Use context.structured<T>() with a JSON Schema for typed output.
 * ═══════════════════════════════════════════════════════════ */

export class MyStructuredMethod extends BaseMethod {
  readonly name = 'my-structured-method';
  readonly description = 'Extract structured data from text';
  readonly task = 'extract-entities';

  async execute(context: MethodContext, params: Record<string, unknown>): Promise<MethodResult> {
    const messages: LiteLLMMessage[] = [
      { role: 'user', content: `Extract information from:\n\n${String(params.text)}` },
    ];

    const data = await context.structured<{
      summary: string;
      keyPoints: string[];
      sentiment: string;
    }>({
      ...this.buildRequest(messages),
      responseFormat: {
        name: 'extraction',
        schema: {
          type: 'object',
          properties: {
            summary: { type: 'string' },
            keyPoints: { type: 'array', items: { type: 'string' } },
            sentiment: { type: 'string', enum: ['positive', 'negative', 'neutral'] },
          },
          required: ['summary', 'keyPoints', 'sentiment'],
        },
        strict: true,
      },
    });

    return {
      content: data.summary,
      data: data as unknown as Record<string, unknown>,
    };
  }
}

/* ═══════════════════════════════════════════════════════════
 * Template D: Combined — Tools + Structured Output
 *
 * Call context.completeWithTools() to gather data via tools,
 * then feed the result into context.structured() for typed extraction.
 * Mix and match freely — no artificial separation.
 * ═══════════════════════════════════════════════════════════ */

export class MyCombinedMethod extends BaseMethod {
  readonly name = 'my-combined-method';
  readonly description = 'Uses tools to gather data, then extracts structured output';
  readonly task = 'memory-query';
  override readonly tools = [new WeatherTool()];

  async execute(context: MethodContext, params: Record<string, unknown>): Promise<MethodResult> {
    const messages: LiteLLMMessage[] = [{ role: 'user', content: String(params.query) }];

    // Step 1: let the LLM call tools to gather information
    const toolResponse = await context.completeWithTools(
      this.buildRequest(messages),
      this.getToolHandlers(),
      5,
    );

    // Step 2: extract structured data from the tool-augmented result
    const data = await context.structured<{ answer: string; confidence: number }>({
      task: this.task,
      messages: [
        ...messages,
        { role: 'assistant', content: toolResponse.content },
        { role: 'user', content: 'Extract the final answer and confidence from the above.' },
      ],
      responseFormat: {
        name: 'result',
        schema: {
          type: 'object',
          properties: {
            answer: { type: 'string' },
            confidence: { type: 'number' },
          },
          required: ['answer', 'confidence'],
        },
        strict: true,
      },
    });

    return { content: data.answer, data: data as unknown as Record<string, unknown> };
  }
}
