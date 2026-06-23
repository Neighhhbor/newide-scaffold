/**
 * 顶层 Agent → Driver 任务指令规划（MVP 占位）
 *
 * 真实实现应由顶层 LLM 阅读 task.spec（及 Persona 等上下文）后，
 * 规划并产出下发给 Driver 的 task_instruction（可能是 spec 的子集或精炼版）。
 *
 * MVP 返回固定字符串，保留 TaskInstructionPlanner 注入点供后续替换为真实 LLM。
 *
 * ## 与 task.spec 的区别
 *
 * | 字段              | 消费者       | 含义                     |
 * |-------------------|--------------|--------------------------|
 * | task.spec         | 顶层 Agent   | 协调层传入的完整任务规格 |
 * | task_instruction  | Driver       | 顶层 Agent 规划后的执行指令 |
 */
import type { AgentTaskRequest } from '../../agent-types';

/**
 * MVP 占位常量：顶层 Agent 尚未接入时，所有任务共用此 Driver 指令。
 * 接入真实 LLM 后由 planTaskInstruction 按 task 动态生成。
 */
export const MVP_TASK_INSTRUCTION_PLACEHOLDER =
  'Execute the driver task according to the planned scope.';

/**
 * MVP 版 TaskInstructionPlanner：忽略 task 内容，返回固定占位字符串。
 *
 * @param _task - 完整任务请求（含 spec）；真实实现将据此规划 instruction
 * @returns 下发给 Driver 的 task_instruction
 */
export async function mockPlanTaskInstruction(_task: AgentTaskRequest): Promise<string> {
  return MVP_TASK_INSTRUCTION_PLACEHOLDER;
}
