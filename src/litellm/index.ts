/**
 * ================================================
 * LiteLLM Client — Internal Module Index
 * ================================================
 * For internal use within the litellm module.
 * Upper layers should import from `./contract` instead.
 */

export { LiteLLMClient } from './client';
export { RequestPool, HttpError } from './request-pool';

export { ModelPool } from './model-pool';
export { ModelRouter, NoModelAvailableError } from './model-router';
export { ModelConfigManager } from './model-config';

export { MethodRouter } from './method-router';
export { MethodRegistry } from './method-registry';
export { BaseMethod, ToolCallingMethod, StructuredMethod } from './method-interface';

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

export { AuditController } from './audit';
export {
  ConsoleAuditSink,
  MemoryAuditSink,
  FileAuditSink,
  CompositeAuditSink,
} from './audit-config';

export { loadLitellmConfig } from './config-loader';

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

export type * from './types';
