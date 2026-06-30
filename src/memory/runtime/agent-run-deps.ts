/**
 * Agent 任务执行依赖注入契约
 *
 * 定义 Agent.runOnce / runTaskMemoryCycle 可替换的五类依赖：
 * 记忆检索、任务指令规划、Driver 调用、经验提取、技能晋升。
 *
 * 由 mvp/default-agent-run-deps.ts 提供默认 MVP 实现组合。
 */
import type { AgentMemoryScope } from '../ports/agent-memory-scope';
import type { AgentContextCleaner } from '../ports/agent-context-cleaner';
import type { ExperienceExtractor } from '../ports/experience-extractor';
import type { DriverReturn, ExperienceRecord } from '../schemas';
import type { AgentTaskRequest } from '../agent-types';
import type { MemoryQueryStrategy } from '../services/memory-query';
import type { DriverContext, PromotionOutcome } from '../types';

/**
 * 顶层 Agent 任务指令规划器。
 * 阅读 task.spec（及未来可能的 Persona 等），产出下发给 Driver 的 task_instruction。
 * 与 queryMemory 分离：指令不负责检索；检索由 buildDriverContext 内部调用 queryMemory。
 */
export type TaskInstructionPlanner = (task: AgentTaskRequest) => Promise<string>;

/**
 * invokeDriver 的输入参数。
 * Driver 仅通过 driver_context 感知任务，不接收 task.spec 或 Persona。
 */
export interface DriverInvokeInput {
  /** 本次任务 ID */
  task_id: string;
  /** Driver 调用 ID，写入 AgentContextSnapshot.driver_calls */
  call_id: string;
  /** 执行的 Driver 标识 */
  source_driver: string;
  /** Driver 可见的全部上下文：task_instruction + skills + experiences */
  driver_context: DriverContext;
}

/**
 * 技能晋升处理器。
 * 在经验提取完成后，判断是否将高置信度经验晋升为 Skill。
 */
export type SkillPromotionHandler = (
  memory: AgentMemoryScope,
  task: AgentTaskRequest,
  experiences: ExperienceRecord[],
) => Promise<PromotionOutcome>;

/**
 * Agent 单轮任务执行的可注入依赖集合。
 * 替换 mock 时只改此对象，不改 Agent / memory-cycle 骨架。
 */
export interface AgentRunDeps {
  /** 记忆检索策略，由 buildDriverContext 内部调用（不含 Persona） */
  queryMemory: MemoryQueryStrategy;
  /** 顶层 Agent 规划 Driver 任务指令（非 task.spec） */
  planTaskInstruction: TaskInstructionPlanner;
  /** 携带 DriverContext 调用 Driver，返回 6 字段报告 */
  invokeDriver: (input: DriverInvokeInput) => Promise<DriverReturn>;
  /** 从 buffer 原材料提取结构化经验 */
  extractor: ExperienceExtractor;
  /** 检查并将符合条件的经验晋升为 Skill */
  promote: SkillPromotionHandler;
  /** 清理顶层 Agent 原始上下文，产出 AgentContextSnapshot（null 时降级） */
  contextCleaner: AgentContextCleaner;
}
