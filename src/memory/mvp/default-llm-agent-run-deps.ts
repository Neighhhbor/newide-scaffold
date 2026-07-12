/**
 * createDefaultLlmAgentRunDeps — 基于 LLM 提取的 Agent 运行依赖工厂
 *
 * 在 defaultMvpAgentRunDeps 基础上，将 extractor 替换为 LlmExperienceExtractor，
 * 其余依赖保持 MVP 不变（planTaskInstruction / invokeDriver 仍为 mock）。
 *
 * 注入 Agent 构造函数第二参数即可启用 LLM 提取。
 *
 * ```ts
 * const agent = new Agent(memory, createDefaultLlmAgentRunDeps());
 * ```
 */
import type { AgentRunDeps } from '../runtime/agent-run-deps';
import type { DeepSeekLlmClientOptions } from '../adapters/deepseek-llm-client';
import { repositoryRetrieveMemoryForTask } from '../adapters/repository-memory-retrieval';
import { DeepSeekLlmClient } from '../adapters/deepseek-llm-client';
import { LlmExperienceExtractor } from '../adapters/llm-experience-extractor';
import { LlmTaskInstructionPlanner } from '../adapters/llm-task-instruction-planner';
import { LlmContextCleaner } from '../adapters/context-cleaner';
import { LlmSkillPromotion } from '../adapters/llm-skill-promotion';
import { invokeMockDriver } from './adapters/mock-driver-invoker';

/** 默认 LLM 提取的 AgentRunDeps 工厂，可传入 DeepSeek 选项覆盖环境变量 */
export function createDefaultLlmAgentRunDeps(options?: DeepSeekLlmClientOptions): AgentRunDeps {
  const llm = new DeepSeekLlmClient(options);
  const planner = new LlmTaskInstructionPlanner(llm);
  return {
    queryMemory: repositoryRetrieveMemoryForTask,
    planTaskInstruction: (task) => planner.plan(task),
    invokeDriver: invokeMockDriver,
    extractor: new LlmExperienceExtractor(llm),
    promote: new LlmSkillPromotion(llm).promote,
    contextCleaner: new LlmContextCleaner(llm),
  };
}
