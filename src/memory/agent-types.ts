/**
 * Agent 运行时 DTO 类型
 *
 * 定义任务派发请求（AgentTaskRequest）、执行循环状态机（AgentLoopState），
 * 以及目标态持久 run loop 的占位结果（AgentLoopTickResult）。
 * 仅在内存中流转，不持久化；与 schemas.ts 中的 AgentHandle 等互补。
 *
 * ## 任务文本的两个层次
 *
 * - spec：Coordinator → 顶层 Agent，完整任务规格
 * - task_instruction：顶层 Agent → Driver，由 planTaskInstruction 在运行期产出，不在此 DTO 中
 */

/**
 * 协调层派发给顶层 Agent 的一次工作任务请求。
 *
 * 不含 task_instruction —— Driver 指令由 Agent 运行期调用 planTaskInstruction 生成。
 */
export interface AgentTaskRequest {
  /**
   * 协调层 → 顶层 Agent 的完整任务规格。
   * 用于顶层 Agent 阅读、竞标、记忆检索 query；不直接传给 Driver。
   */
  spec: string;
  /** 任务唯一标识；缺省则在 runOnce 内自动生成 */
  task_id?: string;
  /** Driver 调用 ID，写入 AgentContextSnapshot.driver_calls 供溯源 */
  call_id?: string;
  /** 执行该任务的 Driver 标识；缺省为 "mock-driver" */
  source_driver?: string;
  /**
   * 测试/演示场景标记，控制晋升等行为分支：
   * - "default"           — 常规流程
   * - "promotion_ready"   — 触发技能晋升
   * - "promotion_blocked" — 验证晋升阻塞
   */
  scenario?: 'default' | 'promotion_ready' | 'promotion_blocked';
  /** Demo 用：覆盖经验置信度，生产环境不应设置 */
  demo_confidence_override?: number;
}

/**
 * Agent 执行循环的生命周期状态。
 *
 * 转换：idle ↔ sleeping ↔ running；任意活跃态 → stopped。
 */
export type AgentLoopState = 'idle' | 'sleeping' | 'running' | 'stopped';

/**
 * 目标态持久 Agent run loop 的单步执行结果。
 *
 * - idle      : Agent 没有待处理的任务，保持 sleeping 状态
 * - skipped   : 当前不支持逐 tick 模式（如 Pipeline 模式），应使用 runOnce
 * - running   : 本轮 tick 执行完毕，仍有工作未完成，可继续 tick
 * - completed : 任务已完成，Agent 已写 buffer 并回到 sleeping
 */
export interface AgentLoopTickResult {
  status: 'idle' | 'skipped' | 'running' | 'completed';
  reason: string;
}
