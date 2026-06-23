/**
 * 旧版 Mock 记忆检索策略（已废弃，保留供对照）
 *
 * 行为与 repository-memory-retrieval 相同，请优先使用后者。
 * 仅返回 { skills, experiences }，不含 Persona / ContextPack / task_instruction。
 */
import type { AgentMemoryScope } from '../../ports/agent-memory-scope';
import type { AgentTaskRequest } from '../../agent-types';
import type { MemoryRetrievalResult } from '../../services/memory-query';
import { retrieveMemoriesForTask } from '../../adapters/driver-context-builder';

/** @deprecated 使用 repositoryRetrieveMemoryForTask 代替 */
export async function mockRetrieveMemoryForTask(
  memory: AgentMemoryScope,
  task: AgentTaskRequest,
  _task_id: string,
): Promise<MemoryRetrievalResult> {
  void _task_id;
  return retrieveMemoriesForTask(memory, { task_query: task.spec });
}
