/**
 * Agent 默认 MVP 运行依赖
 *
 * 组装 mock 检索、mock Driver、mock 提取器、mock 晋升，注入 Agent 构造函数第二参数。
 */
import type { AgentRunDeps } from "../runtime/agent-run-deps";
import { MockExperienceExtractor } from "./adapters/mock-experience-extractor";
import { invokeMockDriver } from "./adapters/mock-driver-invoker";
import { mockRetrieveMemoryForTask } from "./services/mock-memory-retrieval";
import { runMockSkillPromotion } from "./services/skill-promotion";

/** MVP 默认依赖：固定检索、mock Driver、mock 提取与晋升 */
export const defaultMvpAgentRunDeps: AgentRunDeps = {
  queryMemory: mockRetrieveMemoryForTask,
  invokeDriver: invokeMockDriver,
  extractor: new MockExperienceExtractor(),
  promote: runMockSkillPromotion,
};
