/**
 * Agent 默认 MVP 运行依赖
 *
 * 组装 Agent.runOnce 所需的六类可注入依赖。
 * 注入 Agent 构造函数第二参数，替换单项 mock 时不改编排骨架。
 *
 * | 依赖字段              | 实现                              | 职责                         |
 * |-----------------------|-----------------------------------|------------------------------|
 * | queryMemory           | repositoryRetrieveMemoryForTask   | 检索 exp/skill（含 content） |
 * | planTaskInstruction   | mockPlanTaskInstruction           | 产出固定 task_instruction    |
 * | invokeDriver          | invokeMockDriver                  | 返回 mock DriverReturn       |
 * | extractor             | RuleBasedExperienceExtractor      | 从 buffer 提取经验           |
 * | promote               | ruleBasedSkillPromotion           | 按 confidence 晋升技能       |
 * | contextCleaner        | NullContextCleaner                | 无操作（降级路径）           |
 */
import type { AgentRunDeps } from '../runtime/agent-run-deps';
import { repositoryRetrieveMemoryForTask } from '../adapters/repository-memory-retrieval';
import { NullContextCleaner } from '../adapters/null-context-cleaner';
import { RuleBasedExperienceExtractor } from '../adapters/rule-based-experience-extractor';
import { ruleBasedSkillPromotion } from '../services/skill-promotion';
import { invokeMockDriver } from './adapters/mock-driver-invoker';
import { mockPlanTaskInstruction } from './adapters/mock-task-instruction-planner';

/** MVP 默认依赖组合，供 Agent 构造函数默认使用 */
export const defaultMvpAgentRunDeps: AgentRunDeps = {
  queryMemory: repositoryRetrieveMemoryForTask,
  planTaskInstruction: mockPlanTaskInstruction,
  invokeDriver: invokeMockDriver,
  extractor: new RuleBasedExperienceExtractor(),
  promote: ruleBasedSkillPromotion,
  contextCleaner: new NullContextCleaner(),
};
