/**
 * AgentContextCleaner 端口
 *
 * 任务完成后清理顶层 Agent 原始上下文，产出 AgentContextSnapshot。
 * 清理失败时返回 null，提取流程降级为仅使用 DriverReturn。
 */
import type { AgentContextSnapshot, DriverReturn } from "../schemas";

/** AgentContextCleaner 的单次清理输入参数 */
export interface AgentContextCleanInput {
  /** 被清理的 Agent ID */
  agent_id: string;
  /** 来源任务 ID */
  source_task_id: string;
  /** 顶层 Agent 的原始上下文原文（需被清理压缩） */
  raw_context: string;
  /** 本次任务中所有 Driver 调用的返回报告 */
  driver_returns: Array<{
    call_id: string;
    driver_id: string;
    driver_return: DriverReturn;
  }>;
}

export interface AgentContextCleaner {
  /** 清理上下文并返回结构化快照；返回 null 表示清理失败/未实现 */
  clean(input: AgentContextCleanInput): Promise<AgentContextSnapshot | null>;
}
