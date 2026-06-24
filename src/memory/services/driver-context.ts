/**
 * driver-context — Driver 上下文组装服务
 *
 * 负责组装下发给 Driver 的完整上下文：在内部调用 queryMemory 检索记忆，
 * 再与 task_instruction 合并为 DriverContext。
 *
 * ## 职责边界
 *
 * - 输入：memory、task、task_id、task_instruction、queryMemory 策略
 * - 内部：queryMemory → 检索 exp/skill（完整实体）
 * - 输出：DriverContext + 检索结果（供 cycle 观测）
 * - 检索实现见 adapters/memory-retrieval.ts，经 MemoryQueryStrategy 注入
 */
import type { AgentMemoryScope } from '../ports/agent-memory-scope';
import type { AgentTaskRequest } from '../agent-types';
import type { DriverContext } from '../types';
import {
  prepareTaskContext,
  type MemoryQueryStrategy,
  type MemoryRetrievalResult,
} from './memory-query';

/** buildDriverContext 的输入 */
export interface BuildDriverContextInput {
  memory: AgentMemoryScope;
  task: AgentTaskRequest;
  task_id: string;
  /** 顶层 Agent 规划后的 Driver 任务指令 */
  task_instruction: string;
  /** 注入的记忆检索策略（内部调用） */
  queryMemory: MemoryQueryStrategy;
}

/** buildDriverContext 的返回值 */
export interface BuildDriverContextResult {
  driver_context: DriverContext;
  /** 本次检索结果，与 driver_context 中记忆部分一致 */
  retrieval: MemoryRetrievalResult;
}

/**
 * 组装下发给 Driver 的执行上下文。
 *
 * 在内部调用 queryMemory 完成记忆检索，再与 task_instruction 合并。
 */
export async function buildDriverContext(
  input: BuildDriverContextInput,
): Promise<BuildDriverContextResult> {
  const retrieval = await prepareTaskContext(
    input.memory,
    input.task,
    input.task_id,
    input.queryMemory,
  );

  return {
    driver_context: {
      task_instruction: input.task_instruction,
      skills: retrieval.skills,
      experiences: retrieval.experiences,
    },
    retrieval,
  };
}
