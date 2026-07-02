/**
 * defaultLlmAgentRunDeps — 基于 LLM 提取的 Agent 运行依赖对象
 *
 * 在 defaultMvpAgentRunDeps 基础上，将 extractor 替换为 LlmExperienceExtractor，
 * 其余依赖保持 MVP 不变（planTaskInstruction / invokeDriver 仍为 mock）。
 *
 * 注入 Agent 构造函数第二参数即可启用 LLM 提取。
 *
 * ```ts
 * const agent = new Agent(memory, defaultLlmAgentRunDeps);
 * ```
 */
import type { AgentRunDeps } from '../runtime/agent-run-deps';
import { repositoryRetrieveMemoryForTask } from '../adapters/repository-memory-retrieval';
import { NullContextCleaner } from '../adapters/null-context-cleaner';
import { DeepSeekLlmClient } from '../adapters/deepseek-llm-client';
import { LlmExperienceExtractor } from '../adapters/llm-experience-extractor';
import { ruleBasedSkillPromotion } from '../services/skill-promotion';
import { invokeMockDriver } from './adapters/mock-driver-invoker';
import { mockPlanTaskInstruction } from './adapters/mock-task-instruction-planner';

export const defaultLlmAgentRunDeps: AgentRunDeps = {
  queryMemory: repositoryRetrieveMemoryForTask,
  planTaskInstruction: mockPlanTaskInstruction,
  invokeDriver: invokeMockDriver,
  extractor: new LlmExperienceExtractor(new DeepSeekLlmClient()),
  promote: ruleBasedSkillPromotion,
  contextCleaner: new NullContextCleaner(),
};
