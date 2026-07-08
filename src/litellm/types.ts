/**
 * ================================================
 * LiteLLM Type System
 * ================================================
 * All model/provider details are opaque at upper layers.
 * Task types drive model selection; actual model resolution
 * happens in the ModelPool.
 *
 * NOTE: `LiteLLMMessage` is used (not `Message`) to avoid collision
 * with the project-level agent-to-agent `Message` in src/core/message.ts.
 */

// ──────────────────────────────────────────────────────────
// Core Identifiers
// ──────────────────────────────────────────────────────────

/** LiteLLM task type — drives model selection and routing */
export type LiteLLMTaskType = string;

/** Provider identifier — used for auto-selection */
export type Provider = 'openai' | 'anthropic' | 'google' | 'azure' | 'ollama' | string;

/** Model identifier — opaque to upper layers */
export type ModelId = string;

/** Method name for routing */
export type MethodName = string;

// ──────────────────────────────────────────────────────────
// Chat Messages (OpenAI-compatible format)
// ──────────────────────────────────────────────────────────

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/**
 * A single chat completion message.
 * Named `LiteLLMMessage` to distinguish from the project-level
 * `Message` type (agent-to-agent protocol messages).
 */
export interface LiteLLMMessage {
  role: MessageRole;
  content: string;
  /** Optional name for tool messages */
  name?: string;
  /** Tool call ID for tool response messages */
  tool_call_id?: string;
}

// ──────────────────────────────────────────────────────────
// Tools (OpenAI-compatible function calling)
// ──────────────────────────────────────────────────────────

export interface Tool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

/** Tool handler — receives parsed arguments, returns string result */
export type ToolHandler = (args: Record<string, unknown>) => Promise<string> | string;

// ──────────────────────────────────────────────────────────
// Structured Output (JSON Schema)
// ──────────────────────────────────────────────────────────

export interface JsonSchema {
  name: string;
  schema: Record<string, unknown>;
  strict?: boolean;
}

// ──────────────────────────────────────────────────────────
// Completion Request / Response
// ──────────────────────────────────────────────────────────

export interface CompletionRequest {
  /** LiteLLM task type — ModelPool resolves to model(s) */
  task: LiteLLMTaskType;
  /** Conversation messages */
  messages: LiteLLMMessage[];
  /** Available tools for function calling */
  tools?: Tool[] | undefined;
  /** Tool choice override — "auto", "none", "required", or a specific function */
  toolChoice?:
    | 'auto'
    | 'none'
    | 'required'
    | { type: 'function'; function: { name: string } }
    | undefined;
  /** Temperature (0-2) */
  temperature?: number;
  /** Max tokens to generate */
  maxTokens?: number;
  /** Structured output JSON schema */
  responseFormat?: JsonSchema | undefined;
  /** Request timeout override (ms) */
  timeoutMs?: number;
  /** Abort signal for cancellation */
  signal?: AbortSignal | undefined;
  /** Optional metadata passed through to audit */
  metadata?: Record<string, unknown> | undefined;
}

export interface CompletionResponse {
  id: string;
  /** The actual model that served this request */
  model: ModelId;
  content: string;
  toolCalls: ToolCall[];
  usage: TokenUsage;
  finishReason: string;
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

// ──────────────────────────────────────────────────────────
// Streaming
// ──────────────────────────────────────────────────────────

export interface StreamChunk {
  id: string;
  model: ModelId;
  delta: {
    content?: string | undefined;
    toolCalls?: ToolCall[] | undefined;
  };
  finishReason?: string | undefined;
}

// ──────────────────────────────────────────────────────────
// Model Configuration
// ──────────────────────────────────────────────────────────

/** A single model entry in the pool with priority ordering */
export interface ModelEntry {
  /** LiteLLM model identifier, e.g. "openai/gpt-4o" */
  litellmModel: string;
  /** Provider for auto-selection purposes */
  provider: Provider;
  /** Priority order — lower = tried first */
  order: number;
  /** Whether this entry is enabled */
  enabled?: boolean;
  /** Max tokens this model supports */
  maxContextTokens?: number;
  /** Cost per 1K tokens (for reference) */
  costPer1kTokens?: number;
}

/** Model selection strategy */
export type ModelSelectionStrategy =
  /** Use order field: try order=1 first, fallback to order=2 */
  | 'order'
  /** Automatically pick based on API_KEY availability */
  | 'auto'
  /** Use the cheapest available model */
  | 'cheapest'
  /** Use the fastest available model (latency-based) */
  | 'fastest'
  /** Explicit model override (dev only) */
  | { type: 'explicit'; model: string };

/** Per-task model configuration */
export interface LiteLLMTaskConfig {
  /** Task type identifier */
  task: LiteLLMTaskType;
  /** Available model entries for this task */
  models: ModelEntry[];
  /** Selection strategy — defaults to 'order' */
  strategy?: ModelSelectionStrategy;
  /** Request timeout in ms — overrides global default */
  timeoutMs?: number;
  /** Max retry attempts for this task — overrides global default */
  maxRetries?: number;
  /** Temperature — overrides global default */
  temperature?: number;
  /** Max tokens — overrides global default */
  maxTokens?: number;
}

// ──────────────────────────────────────────────────────────
// LiteLLM Client Configuration
// ──────────────────────────────────────────────────────────

export interface LiteLLMClientConfig {
  /** LiteLLM Proxy base URL */
  baseUrl: string;
  /** LiteLLM Proxy API key — if omitted, reads from LITELLM_API_KEY env */
  apiKey?: string;
  /** Global default timeout in ms */
  defaultTimeoutMs: number;
  /** Global default max retries */
  defaultMaxRetries: number;
  /** Global default retry delay in ms */
  defaultRetryDelayMs: number;
  /** Per-task model configurations */
  taskConfigs: LiteLLMTaskConfig[];
  /** Enable debug logging */
  debug: boolean;
}

/** Runtime options passed to the LiteLLM client constructor */
export interface LiteLLMClientOptions {
  /** Override base URL */
  baseUrl?: string;
  /** Override API key */
  apiKey?: string;
  /** Inject custom fetch (for testing) */
  fetch?: typeof fetch;
  /** Inject audit sinks */
  auditSinks?: AuditSink[];
  /** Inject custom method handlers */
  methods?: MethodHandler[];
  /** Inject custom tools */
  tools?: Record<string, ToolHandler>;
}

// ──────────────────────────────────────────────────────────
// Audit
// ──────────────────────────────────────────────────────────

/** Audit record for a single LLM call */
export interface AuditRecord {
  /** Unique call ID */
  callId: string;
  /** Task type */
  task: LiteLLMTaskType;
  /** Method name (if routed through MethodRouter) */
  method?: MethodName;
  /** Selected model */
  model: ModelId;
  /** Start timestamp */
  startTime: Date;
  /** End timestamp (only for completed/failed) */
  endTime?: Date | undefined;
  /** Duration in ms */
  durationMs?: number | undefined;
  /** Token usage */
  usage?: TokenUsage | undefined;
  /** Request message count */
  messageCount: number;
  /** Tool names used in request */
  toolNames: string[];
  /** Error info (only for failed) */
  error?:
    | {
        code: string;
        message: string;
        retryable: boolean;
      }
    | undefined;
  /** Status */
  status: 'started' | 'success' | 'failed';
  /** Optional user-provided metadata */
  metadata?: Record<string, unknown> | undefined;
}

/** Audit interface — implement to capture call lifecycle events */
export interface AuditSink {
  /** Called when an LLM call begins */
  onCallStart(record: AuditRecord): void | Promise<void>;
  /** Called when an LLM call succeeds */
  onCallSuccess(record: AuditRecord): void | Promise<void>;
  /** Called when an LLM call fails */
  onCallFailure(record: AuditRecord): void | Promise<void>;
}

// ──────────────────────────────────────────────────────────
// Method Routing
// ──────────────────────────────────────────────────────────

/** Unified method interface — all callable methods implement this */
export interface MethodHandler {
  /** Method name for routing */
  readonly name: MethodName;
  /** Method description */
  readonly description: string;
  /** Task type this method uses for model selection */
  readonly task: LiteLLMTaskType;
  /** Default tools this method registers */
  readonly defaultTools?: Tool[];
  /** Execute the method */
  execute(
    context: MethodContext,
    params: Record<string, unknown>,
  ): Promise<MethodResult> | MethodResult;
}

/** Context passed to method execution */
export interface MethodContext {
  /** Send a completion request to the LLM */
  complete(request: CompletionRequest): Promise<CompletionResponse>;
  /** Stream a completion */
  stream(request: CompletionRequest): AsyncGenerator<StreamChunk>;
  /** Get structured output */
  structured<T>(request: CompletionRequest & { responseFormat: JsonSchema }): Promise<T>;
  /** Complete with tool auto-execution */
  completeWithTools(
    request: CompletionRequest,
    tools: Record<string, ToolHandler>,
    maxRounds?: number,
  ): Promise<CompletionResponse>;
  /** Access tool registry */
  tools: Record<string, ToolHandler>;
  /** Access memory (injected by scaffold) */
  memory?: unknown;
}

/** Result returned by a method */
export interface MethodResult {
  /** Result content */
  content: string;
  /** Structured data (if applicable) */
  data?: Record<string, unknown> | undefined;
  /** Token usage */
  usage?: TokenUsage | undefined;
  /** Metadata */
  metadata?: Record<string, unknown> | undefined;
}

// ──────────────────────────────────────────────────────────
// Request Pool
// ──────────────────────────────────────────────────────────

export interface RequestPoolConfig {
  /** Max concurrent connections per origin */
  maxConnections: number;
  /** Keep-alive timeout in ms */
  keepAliveTimeout: number;
  /** Max requests per connection before rotating */
  maxRequestsPerConnection: number;
  /** Request timeout in ms */
  requestTimeout: number;
}
