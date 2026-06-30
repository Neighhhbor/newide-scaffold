/**
 * Agent 默认 MVP 运行依赖
 *
 * 组装 Agent.runOnce 所需的五类可注入依赖。
 * 注入 Agent 构造函数第二参数，替换单项 mock 时不改编排骨架。
 *
 * | 依赖字段              | MVP 实现                          | 职责                         |
 * |-----------------------|-----------------------------------|------------------------------|
 * | queryMemory           | repositoryRetrieveMemoryForTask   | 检索 exp/skill（含 content） |
 * | planTaskInstruction   | mockPlanTaskInstruction           | 产出固定 task_instruction    |
 * | invokeDriver          | invokeMockDriver                  | 返回 mock DriverReturn       |
 * | extractor             | MockExperienceExtractor           | 从 buffer 提取经验           |
 * | promote               | runMockSkillPromotion             | 技能晋升（scenario 分支）    |
 */
import type { AgentRunDeps } from '../runtime/agent-run-deps';
import { repositoryRetrieveMemoryForTask } from '../adapters/repository-memory-retrieval';
import { NullContextCleaner } from '../adapters/null-context-cleaner';
import { MockExperienceExtractor } from './adapters/mock-experience-extractor';
import { invokeMockDriver } from './adapters/mock-driver-invoker';
import { mockPlanTaskInstruction } from './adapters/mock-task-instruction-planner';
import { runMockSkillPromotion } from './services/skill-promotion';

/** MVP 默认依赖组合，供 Agent 构造函数默认使用 */
export const defaultMvpAgentRunDeps: AgentRunDeps = {
  queryMemory: repositoryRetrieveMemoryForTask,
  planTaskInstruction: mockPlanTaskInstruction,
  invokeDriver: invokeMockDriver,
  extractor: new MockExperienceExtractor(),
  promote: runMockSkillPromotion,
  contextCleaner: new NullContextCleaner(),
};
