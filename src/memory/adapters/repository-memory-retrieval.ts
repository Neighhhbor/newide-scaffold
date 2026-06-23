/**
 * 基于 repository 的任务前记忆检索（MemoryQueryStrategy 实现）
 *
 * AgentRunDeps.queryMemory 的生产实现：将 AgentTaskRequest 转为检索输入，
 * 委托 driver-context-builder 返回完整 exp/skill 实体。
 *
 * ## 职责边界
 *
 * - 使用 task.spec 作检索 query（顶层 Agent 视角的完整任务）
 * - 不读取 Persona，不产出 task_instruction
 * - 返回结果供 memory-cycle 组装 DriverContext
 *
 * ## 注入点
 *
 * mvp/default-agent-run-deps.ts → defaultMvpAgentRunDeps.queryMemory
 */
import type { AgentMemoryScope } from '../ports/agent-memory-scope';
import type { AgentTaskRequest } from '../agent-types';
import type { MemoryRetrievalResult } from '../services/memory-query';
import { retrieveMemoriesForTask } from './driver-context-builder';

/**
 * 任务执行前的记忆检索策略（MemoryQueryStrategy）。
 *
 * 由 prepareTaskContext 调用；返回的 experiences/skills 将在 memory-cycle 中
 * 与 planTaskInstruction 产出的 task_instruction 合并为 DriverContext。
 *
 * @param memory  - 当前 Agent 的记忆作用域
 * @param task    - 含 spec（作检索 query），不含 Driver 指令
 * @param _task_id - 任务 ID（检索逻辑暂不使用，保留接口一致性）
 */
export async function repositoryRetrieveMemoryForTask(
  memory: AgentMemoryScope,
  task: AgentTaskRequest,
  _task_id: string,
): Promise<MemoryRetrievalResult> {
  void _task_id;
  return retrieveMemoriesForTask(memory, { task_query: task.spec });
}
