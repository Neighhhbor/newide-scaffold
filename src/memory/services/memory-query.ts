/**
 * memory-query — 任务前记忆检索服务
 *
 * 通过注入的 MemoryQueryStrategy 查询 Persona/Skills/Experiences 并装配 ContextPack。
 * MVP 策略见 mvp/services/mock-memory-retrieval.ts。
 */
import type { ContextPack } from "../contract";
import type { AgentMemoryScope } from "../ports/agent-memory-scope";
import type {
  ExperienceRecord,
  PersonaDef,
  SkillRecord,
} from "../schemas";
import type { AgentTaskRequest } from "../agent-types";

export interface MemoryRetrievalResult {
  persona: PersonaDef;
  skills: SkillRecord[];
  experiences: ExperienceRecord[];
  context_pack: ContextPack;
}

export type MemoryQueryStrategy = (
  memory: AgentMemoryScope,
  task: AgentTaskRequest,
  task_id: string,
) => Promise<MemoryRetrievalResult>;

/** 任务执行前：查询记忆并装配上下文 */
export async function prepareTaskContext(
  memory: AgentMemoryScope,
  task: AgentTaskRequest,
  task_id: string,
  query: MemoryQueryStrategy,
): Promise<MemoryRetrievalResult> {
  return query(memory, task, task_id);
}
