/**
 * ================================================
 * LiteLLM Client — Public Contract
 * ================================================
 *
 * This is the **single import surface** for upper layers to use
 * lightweight LLM calls within the scaffold.
 *
 * All upper-layer LLM needs (agent consolidation, council deliberation,
 * orchestrator planning, prompt gates, etc.) go through this module.
 *
 * ## Quick start
 *
 * ```ts
 * import { LiteLLMClient, type LiteLLMMessage } from './litellm/contract';
 *
 * const llm = new LiteLLMClient({ baseUrl: 'http://localhost:4000' });
 * llm.useDefaults();
 *
 * const resp = await llm.complete({
 *   task: 'classify-intent',
 *   messages: [
 *     { role: 'system', content: 'Classify user intent.' },
 *     { role: 'user', content: 'I need help with OAuth.' },
 *   ],
 * });
 * ```
 */

// ── Client ──
export { LiteLLMClient } from './client';

// ── Model subsystem ──
export { ModelPool } from './model-pool';
export { ModelRouter, NoModelAvailableError } from './model-router';
export { ModelConfigManager } from './model-config';

// ── Method subsystem ──
export { MethodRouter } from './method-router';
export { MethodRegistry } from './method-registry';
export { BaseMethod, ToolCallingMethod, StructuredMethod } from './method-interface';

// ── Tool subsystem ──
export { ToolRegistry } from './tool-registry';
export {
  BaseTool,
  createTool,
  objectParam,
  stringParam,
  numberParam,
  enumParam,
} from './tool-interface';
export { QueryMemoryTool, SaveMemoryTool, createMemoryTools } from './memory-tools';
export type { MemoryStore, MemoryEntry } from './memory-tools';

// ── Audit subsystem ──
export { AuditController } from './audit';
export {
  ConsoleAuditSink,
  MemoryAuditSink,
  FileAuditSink,
  CompositeAuditSink,
} from './audit-config';

// ── Config ──
export { loadLitellmConfig } from './config-loader';

// ── Presets ──
export {
  detectAvailableProviders,
  isProviderAvailable,
  autoSelectModels,
  getDefaultTaskConfigs,
  getAutoSelectedTaskConfigs,
  QUICK_CHEAP_MODELS,
  BALANCED_MODELS,
  STRONG_MODELS,
  CODING_MODELS,
} from './model-preset';

// ── Request pool ──
export { RequestPool, HttpError } from './request-pool';

// ── Types (only what upper layers consume) ──
export type {
  // Messages
  LiteLLMMessage,
  MessageRole,

  // Completion
  CompletionRequest,
  CompletionResponse,
  TokenUsage,
  StreamChunk,

  // Structured output
  JsonSchema,

  // Tools
  Tool,
  ToolCall,
  ToolHandler,

  // Model config
  LiteLLMTaskType,
  LiteLLMTaskConfig,
  LiteLLMClientConfig,
  LiteLLMClientOptions,
  ModelEntry,
  ModelSelectionStrategy,

  // Methods
  MethodHandler,
  MethodContext,
  MethodResult,

  // Audit
  AuditSink,
  AuditRecord,
} from './types';
