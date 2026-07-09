/**
 * ================================================
 * LiteLLM Client — Main Entry Point
 * ================================================
 * Orchestrates: ModelPool, MethodRouter, ToolRegistry,
 * AuditController, and RequestPool.
 *
 * Usage:
 *   const client = new LiteLLMClient({ baseUrl: '...' });
 *   client.modelPool.withConfigs(getDefaultTaskConfigs());
 *   client.tools.register(new QueryMemoryTool(store));
 *
 *   // Direct completion
 *   const resp = await client.complete({ task: 'memory-compact', messages });
 *
 *   // Method routing
 *   const result = await client.methods.call('memoryCompaction', { sessionId: 'xxx' });
 */

import { RequestPool } from './request-pool';
import { ModelPool } from './model-pool';
import { MethodRouter } from './method-router';
import { ToolRegistry } from './tool-registry';
import { AuditController } from './audit';
import { getAutoSelectedTaskConfigs } from './model-preset';
import { loadLitellmConfig } from './config-loader';
import { ConsoleAuditSink, MemoryAuditSink } from './audit-config';

import type {
  LiteLLMClientConfig,
  LiteLLMClientOptions,
  CompletionRequest,
  CompletionResponse,
  StreamChunk,
  JsonSchema,
  ToolHandler,
  MethodContext,
  MethodHandler,
  LiteLLMMessage,
  ToolCall,
} from './types';

export class LiteLLMClient {
  readonly modelPool: ModelPool;
  readonly methods: MethodRouter;
  readonly tools: ToolRegistry;
  readonly audit: AuditController;
  readonly pool: RequestPool;

  private readonly config: LiteLLMClientConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(options: LiteLLMClientOptions & { baseUrl?: string } = {}) {
    // Resolve API key from env or explicit option
    const apiKey = options.apiKey ?? process.env.LITELLM_API_KEY ?? '';
    const baseUrl = (
      options.baseUrl ??
      process.env.LITELLM_BASE_URL ??
      'http://localhost:4000'
    ).replace(/\/$/, '');

    if (!apiKey) {
      console.warn(
        '[LiteLLMClient] No API key provided. Set LITELLM_API_KEY env var or pass apiKey option.',
      );
    }

    this.config = {
      baseUrl,
      apiKey,
      defaultTimeoutMs: 30_000,
      defaultMaxRetries: 3,
      defaultRetryDelayMs: 1_000,
      taskConfigs: [],
      debug: false,
    };

    this.fetchImpl = options.fetch ?? globalThis.fetch;

    // Initialize subsystems
    this.pool = new RequestPool(this.fetchImpl);
    this.modelPool = new ModelPool({
      defaultTimeoutMs: this.config.defaultTimeoutMs,
      defaultMaxRetries: this.config.defaultMaxRetries,
      defaultTemperature: 0.3,
      defaultMaxTokens: 2000,
    });
    this.tools = new ToolRegistry();
    this.audit = new AuditController();

    // Method router gets MethodContext from this client
    this.methods = new MethodRouter(() => this.createMethodContext());

    // Apply optional custom methods and tools
    if (options.methods) {
      for (const m of options.methods) {
        this.methods.registry.register(m);
      }
    }
    if (options.tools) {
      for (const [name, handler] of Object.entries(options.tools)) {
        this.tools.registerAdHoc(name, `Tool ${name}`, { type: 'object' }, handler);
      }
    }
    if (options.auditSinks) {
      this.audit.addSinks(options.auditSinks);
    }
  }

  // ═════════════════════════════════════════════════════════
  // Public API: Direct Completion
  // ═════════════════════════════════════════════════════════

  /** Send a single completion request */
  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const resolved = this.modelPool.resolve(request.task);
    const body = this.buildRequestBody(
      request,
      resolved.litellmModel,
      resolved.temperature,
      resolved.maxTokens,
    );
    const url = `${this.config.baseUrl}/v1/chat/completions`;

    const audit = this.audit.startRecord(
      request.task,
      resolved.litellmModel,
      request.messages.length,
      request.tools?.map((t) => t.function.name) ?? [],
      request.metadata,
    );

    try {
      const result = await this.pool.post(url, body, this.config.apiKey ?? '', {
        timeoutMs: request.timeoutMs ?? resolved.timeoutMs,
        maxRetries: resolved.maxRetries,
        ...(request.signal ? { signal: request.signal } : {}),
      });

      const response = await parseCompletionResponse(result.response);

      await audit.end({ usage: response.usage });

      return response;
    } catch (error) {
      await audit.end({
        error: {
          code: error instanceof Error ? error.name : 'UNKNOWN',
          message: error instanceof Error ? error.message : String(error),
          retryable: isRetryableError(error),
        },
      });
      throw error;
    }
  }

  /** Completion with tool auto-execution loop */
  async completeWithTools(
    request: CompletionRequest,
    toolHandlers?: Record<string, ToolHandler>,
    maxRounds = 10,
  ): Promise<CompletionResponse> {
    const handlers = toolHandlers ?? this.tools.getAllHandlers();
    const tools = request.tools ?? this.tools.getAllSchemas();

    if (tools.length === 0) {
      throw new Error('completeWithTools requires tools');
    }

    const messages: LiteLLMMessage[] = [...request.messages];

    for (let round = 0; round < maxRounds; round++) {
      const response = await this.complete({
        ...request,
        messages,
        tools,
      });

      if (response.toolCalls.length === 0) {
        return response;
      }

      messages.push({ role: 'assistant', content: response.content });

      for (const tc of response.toolCalls) {
        const result = await executeToolCall(tc, handlers);
        messages.push({
          role: 'tool',
          content: result,
          tool_call_id: tc.id,
          name: tc.function.name,
        });
      }

      if (this.config.debug) {
        console.log(
          `[LiteLLMClient] Tool round ${round + 1}: ${response.toolCalls.length} tool(s) called`,
        );
      }
    }

    throw new Error(`completeWithTools exceeded max rounds (${maxRounds})`);
  }

  /** Stream completion responses */
  async *stream(request: CompletionRequest): AsyncGenerator<StreamChunk> {
    const resolved = this.modelPool.resolve(request.task);
    const body = this.buildRequestBody(
      { ...request } as CompletionRequest & { stream?: boolean },
      resolved.litellmModel,
      resolved.temperature,
      resolved.maxTokens,
    );
    (body as Record<string, unknown>).stream = true;
    const url = `${this.config.baseUrl}/v1/chat/completions`;

    const result = await this.pool.post(url, body, this.config.apiKey ?? '', {
      timeoutMs: request.timeoutMs ?? resolved.timeoutMs,
      maxRetries: resolved.maxRetries,
      ...(request.signal ? { signal: request.signal } : {}),
    });

    if (!result.response.body) {
      throw new Error('Response body is null');
    }

    const reader = result.response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'data: [DONE]') continue;
          if (trimmed.startsWith('data: ')) {
            const chunk = parseStreamChunk(trimmed.slice(6));
            if (chunk) yield chunk;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /** Get structured JSON output */
  async structured<T = unknown>(
    request: CompletionRequest & { responseFormat: JsonSchema },
  ): Promise<T> {
    const response = await this.complete(request);
    try {
      return extractJson<T>(response.content);
    } catch (e) {
      throw new Error(
        `Failed to parse structured output: ${e}. Content: ${response.content.slice(0, 200)}`,
      );
    }
  }

  // ═════════════════════════════════════════════════════════
  // Public API: Convenience & Setup
  // ═════════════════════════════════════════════════════════

  /** Load default task configs (built-in presets, auto-selection) */
  useDefaults(): this {
    this.modelPool.withConfigs(getAutoSelectedTaskConfigs());
    return this;
  }

  /**
   * Load task→model configuration from a YAML file.
   *
   * @param filePath Path to a litellm-config.yaml file.
   *                 If omitted, loads the default config shipped with this module.
   */
  loadConfig(filePath?: string): this {
    const { tasks } = loadLitellmConfig(filePath);
    this.modelPool.withConfigs(tasks);
    return this;
  }

  /** Enable console audit logging */
  enableConsoleAudit(verbose = false): this {
    this.audit.addSink(new ConsoleAuditSink(verbose));
    return this;
  }

  /** Enable in-memory audit (for testing/inspection) */
  enableMemoryAudit(): { sink: MemoryAuditSink; client: LiteLLMClient } {
    const sink = new MemoryAuditSink();
    this.audit.addSink(sink);
    return { sink, client: this };
  }

  /** Register a method */
  registerMethod(method: MethodHandler): this {
    this.methods.registry.register(method);
    return this;
  }

  // ═════════════════════════════════════════════════════════
  // Private helpers
  // ═════════════════════════════════════════════════════════

  private createMethodContext(): MethodContext {
    return {
      complete: (req) => this.complete(req),
      stream: (req) => this.stream(req),
      structured: (req) => this.structured(req),
      completeWithTools: (req, tools, rounds) => this.completeWithTools(req, tools, rounds),
      tools: this.tools.getAllHandlers(),
    };
  }

  private buildRequestBody(
    request: CompletionRequest,
    model: string,
    temperature: number,
    maxTokens: number,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model,
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.name && { name: m.name }),
        ...(m.tool_call_id && { tool_call_id: m.tool_call_id }),
      })),
    };

    if (request.tools?.length) {
      body.tools = request.tools;
      body.tool_choice = request.toolChoice ?? 'auto';
    }
    body.temperature = request.temperature ?? temperature;
    body.max_tokens = request.maxTokens ?? maxTokens;

    if (request.responseFormat) {
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          name: request.responseFormat.name,
          strict: request.responseFormat.strict ?? true,
          schema: request.responseFormat.schema,
        },
      };
    }

    return body;
  }
}

// ── Parse helpers (module-private) ──

async function parseCompletionResponse(response: Response): Promise<CompletionResponse> {
  const data = (await response.json()) as Record<string, unknown>;
  const choice = (data.choices as Array<Record<string, unknown>>)?.[0];
  const message = choice?.message as Record<string, unknown> | undefined;

  return {
    id: (data.id as string) ?? '',
    model: (data.model as string) ?? '',
    content: (message?.content as string) ?? '',
    toolCalls: parseToolCalls(message?.tool_calls),
    usage: {
      prompt_tokens: (data.usage as Record<string, number>)?.prompt_tokens ?? 0,
      completion_tokens: (data.usage as Record<string, number>)?.completion_tokens ?? 0,
      total_tokens: (data.usage as Record<string, number>)?.total_tokens ?? 0,
    },
    finishReason: (choice?.finish_reason as string) ?? '',
  };
}

function parseToolCalls(toolCalls: unknown): ToolCall[] {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.map((tc: Record<string, unknown>) => ({
    id: (tc.id as string) ?? '',
    type: 'function' as const,
    function: {
      name: (tc.function as Record<string, string>)?.name ?? '',
      arguments: (tc.function as Record<string, string>)?.arguments ?? '{}',
    },
  }));
}

async function executeToolCall(
  tc: ToolCall,
  handlers: Record<string, ToolHandler>,
): Promise<string> {
  const handler = handlers[tc.function.name];
  if (!handler) {
    return JSON.stringify({ error: `Tool '${tc.function.name}' not found` });
  }
  try {
    const args = JSON.parse(tc.function.arguments);
    const result = await handler(args);
    return typeof result === 'string' ? result : JSON.stringify(result);
  } catch (error) {
    return JSON.stringify({
      error: `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

function parseStreamChunk(json: string): StreamChunk | null {
  try {
    const data = JSON.parse(json) as Record<string, unknown>;
    const choice = (data.choices as Array<Record<string, unknown>>)?.[0];
    const delta = choice?.delta as Record<string, unknown> | undefined;
    return {
      id: (data.id as string) ?? '',
      model: (data.model as string) ?? '',
      delta: {
        content: delta?.content as string | undefined,
        toolCalls: parseToolCalls(delta?.tool_calls),
      },
      finishReason: choice?.finish_reason as string | undefined,
    };
  } catch {
    return null;
  }
}

/** Extract JSON from a model response, handling markdown code fences. */
function extractJson<T = unknown>(raw: string): T {
  // Try direct parse first
  try {
    return JSON.parse(raw) as T;
  } catch {
    // noop
  }

  // Try to extract JSON from ```json ... ``` fences
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) {
    return JSON.parse(fence[1].trim()) as T;
  }

  // Try to find the first { ... } or [ ... ] block
  const firstBrace = raw.indexOf('{');
  const firstBracket = raw.indexOf('[');
  if (firstBrace !== -1 || firstBracket !== -1) {
    const start =
      firstBrace === -1
        ? firstBracket
        : firstBracket === -1
          ? firstBrace
          : Math.min(firstBrace, firstBracket);
    const endChar = raw[start] === '{' ? '}' : ']';
    let depth = 0;
    let end = -1;
    for (let i = start; i < raw.length; i++) {
      if (raw[i] === raw[start]) depth++;
      else if (raw[i] === endChar) depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
    if (end !== -1) {
      return JSON.parse(raw.slice(start, end + 1)) as T;
    }
  }

  throw new Error('No JSON found in response');
}

function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'AbortError') return true;
  return ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED'].some((c) => error.message?.includes(c));
}
