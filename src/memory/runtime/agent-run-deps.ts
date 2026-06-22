/**
 * Agent 任务执行依赖注入契约
 *
 * 定义 runOnce 可替换的四类依赖：记忆检索、Driver 调用、经验提取、技能晋升。
 * 由 mvp/default-agent-run-deps.ts 提供默认 mock 实现。
 */
import type { AgentMemoryScope } from "../ports/agent-memory-scope";
import type { ExperienceExtractor } from "../ports/experience-extractor";
import type { DriverReturn, ExperienceRecord } from "../schemas";
import type { AgentTaskRequest } from "../agent-types";
import type { MemoryRetrievalResult, MemoryQueryStrategy } from "../services/memory-query";
import type { PromotionOutcome } from "../types";

export interface DriverInvokeInput {
  task: AgentTaskRequest;
  task_id: string;
  call_id: string;
  source_driver: string;
  retrieval: MemoryRetrievalResult;
}

export type SkillPromotionHandler = (
  memory: AgentMemoryScope,
  task: AgentTaskRequest,
  experiences: ExperienceRecord[],
) => Promise<PromotionOutcome>;

export interface AgentRunDeps {
  queryMemory: MemoryQueryStrategy;
  invokeDriver: (input: DriverInvokeInput) => Promise<DriverReturn>;
  extractor: ExperienceExtractor;
  promote: SkillPromotionHandler;
}
