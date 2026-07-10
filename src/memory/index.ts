/**
 * memory 模块统一导出入口
 *
 * 对外暴露：跨方向契约（contract）、Spec 类型（schemas）、存储适配器、
 * 正式服务（memory-query / memory-cycle / buffer-writer）、Agent 运行时，
 * 以及可移除的 mvp mock 实现。
 */
export * from './contract';
export * from './types';
export * as schemas from './schemas';
export { MockMemoryProvider } from './mock-memory';
export { RepositoryMemoryProvider } from './adapters/repository-memory-provider';
export { InMemoryRepository } from './adapters/in-memory-repository';
export { InMemoryBufferRepository } from './adapters/in-memory-buffer-repository';
export {
  FileBufferRepository,
  type FileBufferRepositoryOptions,
} from './adapters/file-buffer-repository';
export {
  PgMemoryRepository,
  type PgMemoryRepositoryOptions,
} from './adapters/pg-memory-repository';
export { ensurePgMemorySchema } from './adapters/pg-memory-schema';
export { createAgentMemoryScope } from './adapters/agent-memory-scope';
export { NullContextCleaner } from './adapters/null-context-cleaner';
export { RuleBasedExperienceExtractor } from './adapters/rule-based-experience-extractor';
export { LlmExperienceExtractor } from './adapters/llm-experience-extractor';
export { LlmTaskInstructionPlanner } from './adapters/llm-task-instruction-planner';
export { LlmContextCleaner } from './adapters/context-cleaner';
export { LlmSkillPromotion } from './adapters/llm-skill-promotion';
export { MockLlmClient } from './adapters/mock-llm-client';
export { DeepSeekLlmClient } from './adapters/deepseek-llm-client';
export { DeepSeekToolCallingClient } from './adapters/deepseek-tool-calling-client';
export type { DeepSeekToolCallingClientOptions } from './adapters/deepseek-tool-calling-client';
export { RepositoryAgentBoardQuery } from './adapters/agent-board-query';
export { BatchBufferTriggerPolicy } from './adapters/batch-buffer-trigger-policy';
export { AlwaysExtractPolicy } from './adapters/always-extract-policy';
export { DefaultPromotionTriggerPolicy } from './adapters/default-promotion-trigger-policy';

// Ports — 公开接口类型
export type { BufferRepository, SaveBufferResult } from './ports/buffer-repository';
export type { MemoryRepository, MemoryVectorSearchOptions } from './ports/memory-repository';
export type { AgentMemoryScope } from './ports/agent-memory-scope';
export type { ExperienceExtractor } from './ports/experience-extractor';
export type { EmbeddingProvider } from './ports/embedding-provider';
export type { LlmClient, LlmMessage } from './ports/llm-client';
export type { SkillMarketPort, SkillMarketSearchResult } from './ports/skill-market-port';
export type { AgentContextCleaner, AgentContextCleanInput } from './ports/agent-context-cleaner';
export type { BufferTriggerPolicy } from './ports/buffer-trigger-policy';
export type { PromotionTriggerPolicy } from './ports/promotion-trigger-policy';
export type {
  AgentBoardQuery,
  AgentBoardListItem,
  AgentBoardAgentView,
  SkillView,
  ExperienceView,
} from './ports/agent-board-query';
export type {
  ExternalMemoryRepository,
  SearchAccessibleMemoriesInput,
  SearchAccessibleMemoriesOutput,
  SearchAccessibleMemoryHit,
  LoadAccessibleMemoriesInput,
  LoadAccessibleMemoriesOutput,
  RecordMemoryUsageFeedbackInput,
  MemoryItemType,
} from './ports/external-memory-repository';

// Agent runtime types
export type { AgentTaskRequest, AgentLoopState, AgentLoopTickResult } from './agent-types';
export type {
  AgentRunDeps,
  DriverInvokeInput,
  SkillPromotionHandler,
  TaskInstructionPlanner,
} from './runtime/agent-run-deps';

// Tool-calling types
export type {
  Tool,
  ToolDefinition,
  ToolCall,
  ToolCallMessage,
  ToolCallResult,
  ToolCallingClient,
} from './runtime/tool';
export { ToolRegistry } from './runtime/tool';

// AgentToolConfig
export type { AgentToolConfig } from './runtime/agent';

// Tools
export { QueryMemoryTool } from './runtime/tools/query-memory-tool';
export type { QueryMemoryInput, QueryMemoryOutput } from './runtime/tools/query-memory-tool';
export { InvokeDriverTool } from './runtime/tools/invoke-driver-tool';
export type { DriverTask, DriverHandler } from './runtime/tools/invoke-driver-tool';

// Production runtime bootstrap
export { createAgentRuntime } from './runtime/create-agent-runtime';
export type { AgentRuntimeConfig } from './runtime/create-agent-runtime';

// Prompts
export { buildAgentSystemPrompt } from './prompts/agent-system-prompt';

// 正式服务
export { writePendingBuffer } from './services/buffer-writer';
export {
  buildDriverContext,
  type BuildDriverContextInput,
  type BuildDriverContextResult,
} from './services/driver-context';
export { prepareTaskContext, type MemoryQueryStrategy } from './services/memory-query';
export {
  retrieveMemoriesForTask,
  type MemoryRetrievalOptions,
  type MemoryRelevancePolicy,
  type RetrieveMemoriesInput,
} from './adapters/memory-retrieval';
export { repositoryRetrieveMemoryForTask } from './adapters/repository-memory-retrieval';
export { ruleBasedSkillPromotion } from './services/skill-promotion';
export {
  ingestTaskBuffer,
  processPendingBuffer,
  runTaskMemoryCycle,
} from './services/memory-cycle';

// BufferProcessor 运行时
export { ExperienceExtractorProcessor } from './runtime/experience-extractor-processor';
export { SkillPromotionProcessor } from './runtime/skill-promotion-processor';

// Agent 运行时
export { Agent } from './runtime/agent';
export {
  AgentManager,
  type AgentManagerOptions,
  type SubmitTaskResult,
  type DispatchTaskResult,
  type MemoryTaskProjection,
  toMemoryTaskProjection,
} from './runtime/agent-manager';

// MVP mock（可整包移除）
export { defaultMvpAgentRunDeps } from './mvp/default-agent-run-deps';
export { createDefaultLlmAgentRunDeps } from './mvp/default-llm-agent-run-deps';
export { MockExperienceExtractor } from './mvp/adapters/mock-experience-extractor';

// Competition Claim
export type {
  CompetitionDecision,
  AgentCompetitionClaimContent,
  AgentCompetitionClaim,
  CompetitionClaimBatch,
  CollectCompetitionClaimsOptions,
} from './competition-types';
export type { CompetitionClaimEvaluator } from './ports/competition-claim-evaluator';
export { createMockCompetitionClaimEvaluator } from './adapters/mock-competition-claim-evaluator';
