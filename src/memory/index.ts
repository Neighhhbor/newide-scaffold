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
export { QueryMemoryTool, SaveMemoryTool, createMemoryTools } from './litellm-memory-tools';
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
export { RepositoryAgentBoardQuery } from './adapters/agent-board-query';

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

// Agent 运行时
export { Agent } from './runtime/agent';
export {
  AgentManager,
  type AgentManagerOptions,
  type SubmitTaskResult,
  type MemoryTaskProjection,
  toMemoryTaskProjection,
} from './runtime/agent-manager';

// MVP mock（可整包移除）
export { defaultMvpAgentRunDeps } from './mvp/default-agent-run-deps';
export { createDefaultLlmAgentRunDeps } from './mvp/default-llm-agent-run-deps';
export { MockExperienceExtractor } from './mvp/adapters/mock-experience-extractor';
