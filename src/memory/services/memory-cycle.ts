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
import { createId, nowTimestamp } from '../../core';
import type { AgentMemoryScope } from '../ports/agent-memory-scope';
import type { MemoryRepository } from '../ports/memory-repository';
import type { BufferRepository } from '../ports/buffer-repository';
import type { ExperienceExtractor } from '../ports/experience-extractor';
import type { AgentRunDeps } from '../runtime/agent-run-deps';
import type { TelemetrySink } from '../../telemetry/telemetry-sink';
import type {
  AgentContextSnapshot,
  BufferSnapshot,
  DriverReturn,
  ExperienceRecord,
} from '../schemas';
import type { AgentTaskRequest } from '../agent-types';
import type { ExtractionOutput, MemoryCycleResult, PromotionOutcome } from '../types';
import type { LlmClient } from '../ports/llm-client';
import { LlmExperienceExtractor } from '../adapters/llm-experience-extractor';
import { LlmSkillPromotion } from '../adapters/llm-skill-promotion';
import { createAgentMemoryScope } from '../adapters/agent-memory-scope';
import { writePendingBuffer } from './buffer-writer';
import { buildDriverContext } from './driver-context';
import { recordMemoryCycleTelemetry } from '../../telemetry/memory-cycle-observer';

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
  agentContext?: AgentContextSnapshot | undefined;
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

export interface MemoryCycleOptions {
  telemetry?: TelemetrySink;
  run_id?: string;
  memory_ablation?: string;
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
 * 主动提取：从指定 pending buffer 中提取经验并保存，不做晋升。
 *
 * 适合场景：只想跑提取、查看 LLM 抽出了什么经验，暂不晋升。
 *
 * @param memory - Agent 记忆作用域
 * @param seq    - pending buffer 序号
 * @param llm    - LLM 客户端
 * @returns 提取结果（含 experiences 列表）
 */
export async function extractBuffer(
  memory: AgentMemoryScope,
  seq: number,
  llm: LlmClient,
): Promise<ExtractionOutput> {
  const pending = await memory.getPendingBuffer(seq);
  if (!pending) {
    throw new Error(`Pending buffer not found: seq=${seq}`);
  }

  const extractor = new LlmExperienceExtractor(llm);
  const extraction = await extractor.extract(pending.snapshot, pending.agentContext);

  for (const experience of extraction.experiences) {
    await memory.saveExperience(experience);
  }

  return extraction;
}

/**
 * 主动晋升：扫描 repo 中已保存的未晋升经验，调用 LLM 晋升为技能。
 *
 * 筛选条件：
 *   - type === 'positive'
 *   - confidence > 0.95
 *   - promoted_to === undefined
 *
 * 每条经验晋升后自动调用 memory.saveSkill() 和 memory.updateExperience()。
 *
 * @param memory - Agent 记忆作用域
 * @param llm    - LLM 客户端
 * @returns 晋升结果列表（每个 eligible 经验一条）
 */
export async function promoteExperiences(
  memory: AgentMemoryScope,
  llm: LlmClient,
): Promise<PromotionOutcome[]> {
  const all = await memory.listExperiences();
  const eligible = all.filter(
    (e) => e.type === 'positive' && e.confidence > 0.95 && e.promoted_to === undefined,
  );

  if (eligible.length === 0) {
    return [];
  }

  const promoter = new LlmSkillPromotion(llm);
  const dummyTask: AgentTaskRequest = {
    spec: 'skill-promotion',
    task_id: `promotion-${createId('promo')}`,
    call_id: `promotion-${createId('promo')}`,
    source_driver: 'promotion-processor',
  };

  const results: PromotionOutcome[] = [];
  for (const experience of eligible) {
    const outcome = await promoter.promote(memory, dummyTask, [experience]);
    results.push(outcome);
  }

  return results;
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
  options?: MemoryCycleOptions,
): Promise<MemoryCycleResult> {
  const telemetry = options?.telemetry ?? deps.telemetry;
  const task_id = task.task_id ?? createId('task');
  const call_id = task.call_id ?? createId('call');
  const source_driver = task.source_driver ?? 'mock-driver';

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

  const agentContext = await deps.contextCleaner.clean({
    agent_id: memory.role_id,
    source_task_id: task_id,
    raw_context: `Task spec: ${task.spec}\nInstruction: ${task_instruction}`,
    driver_returns: [{ call_id, driver_id: source_driver, driver_return }],
  });

  const ingested = await ingestTaskBuffer(memory, {
    task,
    task_id,
    call_id,
    source_driver,
    driver_return,
    agentContext: agentContext ?? undefined,
  });

  const { extraction, promotion } = await processPendingBuffer(memory, ingested.seq, {
    task,
    extractor: deps.extractor,
    promote: deps.promote,
  });

  if (telemetry) {
    const skills_after = await memory.listSkills();
    const experiences_after = await memory.listExperiences();
    await recordMemoryCycleTelemetry(telemetry, {
      context: {
        task_id,
        role_id: memory.role_id,
        ...(options?.run_id ? { run_id: options.run_id } : {}),
        ...(options?.memory_ablation ? { memory_ablation: options.memory_ablation } : {}),
      },
      retrieval,
      call_id,
      source_driver,
      driver_return,
      buffer_seq: ingested.seq,
      extract_result: extraction.result,
      promotion,
      persona,
      skills_after,
      experience_count: experiences_after.length,
    });
  }

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

/**
 * 批量提取：对所有 Agent 的每条 pending buffer 执行 extractBuffer。
 *
 * @param repository       - Agent 注册仓库（用于列出所有 role_id）
 * @param bufferRepository - Buffer 仓库
 * @param llm              - LLM 客户端
 * @returns 每个 Agent 的提取结果列表
 */
export async function extractAllBuffers(
  repository: MemoryRepository,
  bufferRepository: BufferRepository,
  llm: LlmClient,
): Promise<{ role_id: string; results: ExtractionOutput[] }[]> {
  const agentIds = await repository.listAgentIds();
  const allResults: { role_id: string; results: ExtractionOutput[] }[] = [];

  for (const role_id of agentIds) {
    const memory = createAgentMemoryScope(repository, bufferRepository, role_id);
    const seqs = await memory.listPendingBufferSeqs();
    if (seqs.length === 0) continue;

    const results: ExtractionOutput[] = [];
    for (const seq of seqs) {
      const extraction = await extractBuffer(memory, seq, llm);
      results.push(extraction);
    }
    allResults.push({ role_id, results });
  }

  return allResults;
}

/**
 * 批量晋升：对所有 Agent 执行 promoteExperiences。
 *
 * @param repository       - Agent 注册仓库（用于列出所有 role_id）
 * @param bufferRepository - Buffer 仓库
 * @param llm              - LLM 客户端
 * @returns 每个 Agent 的晋升结果列表
 */
export async function promoteAllExperiences(
  repository: MemoryRepository,
  bufferRepository: BufferRepository,
  llm: LlmClient,
): Promise<{ role_id: string; outcomes: PromotionOutcome[] }[]> {
  const agentIds = await repository.listAgentIds();
  const allResults: { role_id: string; outcomes: PromotionOutcome[] }[] = [];

  for (const role_id of agentIds) {
    const memory = createAgentMemoryScope(repository, bufferRepository, role_id);
    const outcomes = await promoteExperiences(memory, llm);
    allResults.push({ role_id, outcomes });
  }

  return allResults;
}

/**
 * 指定 Agent 提取：根据 role_id 创建 memory scope 后提取。
 *
 * @param role_id          - 目标 Agent
 * @param seq              - pending buffer 序号
 * @param repository       - Agent 注册仓库
 * @param bufferRepository - Buffer 仓库
 * @param llm              - LLM 客户端
 */
export async function extractBufferForAgent(
  role_id: string,
  seq: number,
  repository: MemoryRepository,
  bufferRepository: BufferRepository,
  llm: LlmClient,
): Promise<ExtractionOutput> {
  const memory = createAgentMemoryScope(repository, bufferRepository, role_id);
  return extractBuffer(memory, seq, llm);
}

/**
 * 指定 Agent 晋升：根据 role_id 创建 memory scope 后晋升。
 *
 * @param role_id          - 目标 Agent
 * @param repository       - Agent 注册仓库
 * @param bufferRepository - Buffer 仓库
 * @param llm              - LLM 客户端
 */
export async function promoteExperiencesForAgent(
  role_id: string,
  repository: MemoryRepository,
  bufferRepository: BufferRepository,
  llm: LlmClient,
): Promise<PromotionOutcome[]> {
  const memory = createAgentMemoryScope(repository, bufferRepository, role_id);
  return promoteExperiences(memory, llm);
}
