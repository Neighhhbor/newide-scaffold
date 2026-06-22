/**
 * Agent 运行时 DTO 类型
 *
 * 定义任务派发请求（AgentTaskRequest）与执行循环状态机（AgentLoopState）。
 * 仅在内存中流转，不持久化；与 schemas.ts 中的 AgentHandle 等互补。
 */

/**
 * Agent 收到的一次工作任务请求
 *
 * 由协调层（Coordinator）在分配任务时构造，传递给 Agent 执行循环。
 * 对应方向 B 文档 §3.2 "Task Dispatch" 中的任务分发消息。
 */
export interface AgentTaskRequest {
  /** 任务规格说明文本（自然语言 + 结构化指令） */
  spec: string;
  /** 协调流程传入的任务 ID；缺省则在 runOnce 内生成 */
  task_id?: string;
  /** Driver 调用 ID，写入 AgentContextSnapshot.driver_calls */
  call_id?: string;
  /** 执行该任务的 Driver 标识；缺省为 mock-driver */
  source_driver?: string;
  /**
   * 测试/演示场景标记，用于控制 Agent 的行为分支：
   * - "default"            — 常规任务流程
   * - "promotion_ready"    — 模拟晋升条件已满足，触发技能晋升检查
   * - "promotion_blocked"  — 模拟晋升被规则阻止，验证阻塞逻辑
   */
  scenario?: "default" | "promotion_ready" | "promotion_blocked";
  /**
   * Demo 模式下覆盖经验置信度，跳过正常置信度计算流程。
   * 仅在测试/演示时使用，生产环境不应设置。
   */
  demo_confidence_override?: number;
}

/**
 * Agent 执行循环的生命周期状态
 *
 * 状态转换路径：
 *   idle → running → idle   （正常任务循环）
 *   idle → sleeping          （无任务时空转等待）
 *   sleeping → running       （被新任务唤醒）
 *   running → stopped        （主动停止或异常终止）
 *   idle → stopped           （外部关闭信号）
 */
export type AgentLoopState = "idle" | "sleeping" | "running" | "stopped";
