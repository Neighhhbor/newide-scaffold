/**
 * memory-query — 任务前记忆检索服务
 *
 * 定义记忆检索的结果类型与策略接口，并提供 prepareTaskContext 编排入口。
 * 检索范围：与 Driver 相关的 Skills / Experiences（完整实体，含 content）。
 * 不含 Persona、不含 ContextPack。
 *
 * 默认策略实现：adapters/repository-memory-retrieval.ts → adapters/memory-retrieval.ts
 */
import type { AgentMemoryScope } from '../ports/agent-memory-scope';
import type { ExperienceRecord, SkillRecord } from '../schemas';
import type { AgentTaskRequest } from '../agent-types';

/**
 * 记忆检索结果。
 * 仅含 skills 与 experiences，供 buildDriverContext 组装 DriverContext 的记忆部分。
 * Persona 与 task_instruction 不在此结构中。
 */
export interface MemoryRetrievalResult {
  /** 入选技能（完整 SkillRecord，含 content） */
  skills: SkillRecord[];
  /** 入选经验（完整 ExperienceRecord，含 content） */
  experiences: ExperienceRecord[];
}

/**
 * 可注入的记忆检索策略函数类型。
 * 由 AgentRunDeps.queryMemory 提供具体实现。
 */
export type MemoryQueryStrategy = (
  memory: AgentMemoryScope,
  task: AgentTaskRequest,
  task_id: string,
) => Promise<MemoryRetrievalResult>;

/**
 * 任务执行前的记忆检索编排入口。
 * 由 buildDriverContext 内部调用，将检索委托给注入的 MemoryQueryStrategy。
 *
 * @param memory  - Agent 记忆作用域
 * @param task    - 任务请求（策略通常用 task.spec 作 query）
 * @param task_id - 任务 ID
 * @param query   - 注入的检索策略（如 repositoryRetrieveMemoryForTask）
 */
export async function prepareTaskContext(
  memory: AgentMemoryScope,
  task: AgentTaskRequest,
  task_id: string,
  query: MemoryQueryStrategy,
): Promise<MemoryRetrievalResult> {
  return query(memory, task, task_id);
}
