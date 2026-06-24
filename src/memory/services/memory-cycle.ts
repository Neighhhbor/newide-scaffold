/**
 * memory-cycle — 任务记忆全周期编排服务
 *
 * 串联任务前检索、指令规划、Driver 调用、buffer 写入、经验提取与技能晋升。
 *
 * ## 主流程（runTaskMemoryCycle）
 *
 * ```
 * getPersona（仅元数据，不进 Driver）
 *   → planTaskInstruction（task_instruction）
 *   → buildDriverContext（内部 queryMemory + 组装）
 *   → invokeDriver
 *   → ingestTaskBuffer
 *   → processPendingBuffer
 * ```
 */
import { randomUUID } from 'node:crypto';
import { createId, nowTimestamp } from '../../core';
import type { AgentMemoryScope } from '../ports/agent-memory-scope';
import type { ExperienceExtractor } from '../ports/experience-extractor';
import type { AgentRunDeps } from '../runtime/agent-run-deps';
import type {
  AgentContextSnapshot,
  BufferSnapshot,
  DriverReturn,
  ExperienceRecord,
} from '../schemas';
import type { AgentTaskRequest } from '../agent-types';
import type { ExtractionOutput, MemoryCycleResult, PromotionOutcome } from '../types';
import { writePendingBuffer } from './buffer-writer';
import { buildDriverContext } from './driver-context';

/**
 * ingestTaskBuffer 的输入。
 * 将 Driver 返回报告与顶层 Agent 上下文快照成对写入 pending buffer。
 */
export interface TaskBufferIngestInput {
  /** 原始任务请求（buffer 中 task_description 取 task.spec） */
  task: AgentTaskRequest;
  task_id: string;
  call_id: string;
  source_driver: string;
  /** Driver 6 字段结构化报告 */
  driver_return: DriverReturn;
  /** 顶层 Agent 清理后的上下文快照（与 buffer 成对存储） */
  agentContext: AgentContextSnapshot;
}

/**
 * processPendingBuffer 的输入。
 * 指定提取器与晋升处理器，对单条 pending buffer 执行后处理。
 */
export interface ProcessPendingInput {
  task: AgentTaskRequest;
  extractor: ExperienceExtractor;
  promote: (
    memory: AgentMemoryScope,
    task: AgentTaskRequest,
    experiences: ExperienceRecord[],
  ) => Promise<PromotionOutcome>;
}

/** processPendingBuffer 的返回：提取结果 + 晋升结果 */
export interface ProcessPendingResult {
  extraction: ExtractionOutput;
  promotion: PromotionOutcome;
}

/**
 * 将 Driver 报告与 Agent 上下文写入 pending buffer。
 * task_description 使用 task.spec（完整任务规格），非 task_instruction。
 *
 * @returns 分配的 buffer 序号与快照副本
 */
export async function ingestTaskBuffer(
  memory: AgentMemoryScope,
  input: TaskBufferIngestInput,
): Promise<{ seq: number; snapshot: BufferSnapshot }> {
  const snapshot: BufferSnapshot = {
    task_id: input.task_id,
    task_description: input.task.spec,
    driver_return: input.driver_return,
    source_task_id: input.task_id,
    source_driver: input.source_driver,
    received_at: nowTimestamp(),
    retry_count: 0,
    extraction_status: 'pending',
  };

  const saved = await writePendingBuffer(memory, snapshot, input.agentContext);
  return { seq: saved.seq, snapshot: saved.snapshot };
}

/**
 * 处理单条 pending buffer：提取经验 → 入库 → 晋升检查 → 标记 processed。
 */
export async function processPendingBuffer(
  memory: AgentMemoryScope,
  seq: number,
  input: ProcessPendingInput,
): Promise<ProcessPendingResult> {
  const pending = await memory.getPendingBuffer(seq);
  if (!pending) {
    throw new Error(`Pending buffer not found: seq=${seq}`);
  }

  const extraction = await input.extractor.extract(pending.snapshot, pending.agentContext);

  for (const experience of extraction.experiences) {
    await memory.saveExperience(experience);
  }

  const promotion = await input.promote(memory, input.task, extraction.experiences);
  if (promotion.skill) {
    extraction.result.skills_promoted = 1;
  }

  await memory.markBufferProcessed(seq);
  return { extraction, promotion };
}

/**
 * 单轮任务记忆全周期主入口。
 *
 * 1. 读取 Persona（仅写入 cycle 结果，不传给 Driver）
 * 2. 规划 task_instruction
 * 3. buildDriverContext（内部 queryMemory + 组装）并调用 Driver
 * 4. 写入 buffer → 提取经验 → 技能晋升
 *
 * @param memory - Agent 记忆作用域
 * @param task   - 协调层任务请求（含 spec）
 * @param deps   - 可注入的运行依赖
 */
export async function runTaskMemoryCycle(
  memory: AgentMemoryScope,
  task: AgentTaskRequest,
  deps: AgentRunDeps,
): Promise<MemoryCycleResult> {
  const task_id = task.task_id ?? createId('task');
  const call_id = task.call_id ?? createId('call');
  const source_driver = task.source_driver ?? 'mock-driver';
  const received_at = nowTimestamp();

  const skills_before = await memory.listSkills();
  const persona = await memory.getPersona();

  const task_instruction = await deps.planTaskInstruction(task);
  const { driver_context, retrieval } = await buildDriverContext({
    memory,
    task,
    task_id,
    task_instruction,
    queryMemory: deps.queryMemory,
  });

  const driver_return = await deps.invokeDriver({
    task_id,
    call_id,
    source_driver,
    driver_context,
  });

  const agentContext: AgentContextSnapshot = {
    snapshot_id: randomUUID(),
    source_task_id: task_id,
    agent_id: memory.role_id,
    thinking_trace: `Agent reasoning for ${task_id}: spec="${task.spec}"`,
    planning_trace: `Driver instruction: ${task_instruction}`,
    driver_calls: [
      {
        call_id,
        driver_id: source_driver,
        driver_return_ref: 'report_pending.json',
      },
    ],
    cleaned_at: received_at,
    original_token_count: 1000,
    cleaned_token_count: 400,
    compression_ratio: 0.4,
  };

  const ingested = await ingestTaskBuffer(memory, {
    task,
    task_id,
    call_id,
    source_driver,
    driver_return,
    agentContext,
  });

  const { extraction, promotion } = await processPendingBuffer(memory, ingested.seq, {
    task,
    extractor: deps.extractor,
    promote: deps.promote,
  });

  return {
    agent_id: memory.role_id,
    persona,
    skills_before,
    retrieval,
    driver_context,
    buffer_snapshot: ingested.snapshot,
    buffer_seq: ingested.seq,
    extraction,
    promotion,
  };
}
