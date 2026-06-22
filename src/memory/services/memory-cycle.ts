/**
 * memory-cycle — 任务后 buffer 与记忆处理服务
 *
 * ingestTaskBuffer：写入 pending 原材料；
 * processPendingBuffer：提取经验、晋升技能、标记 processed；
 * runTaskMemoryCycle：MVP 同步串联全流程（查询 → Driver → ingest → process）。
 */
import { randomUUID } from "node:crypto";
import { createId, nowTimestamp } from "../../core";
import type { AgentMemoryScope } from "../ports/agent-memory-scope";
import type { ExperienceExtractor } from "../ports/experience-extractor";
import type { AgentRunDeps } from "../runtime/agent-run-deps";
import type {
  AgentContextSnapshot,
  BufferSnapshot,
  DriverReturn,
  ExperienceRecord,
} from "../schemas";
import type { AgentTaskRequest } from "../agent-types";
import type {
  ExtractionOutput,
  MemoryCycleResult,
  PromotionOutcome,
} from "../types";
import { writePendingBuffer } from "./buffer-writer";
import { prepareTaskContext } from "./memory-query";

export interface TaskBufferIngestInput {
  task: AgentTaskRequest;
  task_id: string;
  call_id: string;
  source_driver: string;
  driver_return: DriverReturn;
  agentContext: AgentContextSnapshot;
}

export interface ProcessPendingInput {
  task: AgentTaskRequest;
  extractor: ExperienceExtractor;
  promote: (
    memory: AgentMemoryScope,
    task: AgentTaskRequest,
    experiences: ExperienceRecord[],
  ) => Promise<PromotionOutcome>;
}

export interface ProcessPendingResult {
  extraction: ExtractionOutput;
  promotion: PromotionOutcome;
}

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
    extraction_status: "pending",
  };

  const saved = await writePendingBuffer(memory, snapshot, input.agentContext);
  return { seq: saved.seq, snapshot: saved.snapshot };
}

export async function processPendingBuffer(
  memory: AgentMemoryScope,
  seq: number,
  input: ProcessPendingInput,
): Promise<ProcessPendingResult> {
  const pending = await memory.getPendingBuffer(seq);
  if (!pending) {
    throw new Error(`Pending buffer not found: seq=${seq}`);
  }

  const extraction = await input.extractor.extract(
    pending.snapshot,
    pending.agentContext,
  );

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

export async function runTaskMemoryCycle(
  memory: AgentMemoryScope,
  task: AgentTaskRequest,
  deps: AgentRunDeps,
): Promise<MemoryCycleResult> {
  const task_id = task.task_id ?? createId("task");
  const call_id = task.call_id ?? createId("call");
  const source_driver = task.source_driver ?? "mock-driver";
  const received_at = nowTimestamp();

  const skills_before = await memory.listSkills();
  const persona = await memory.getPersona();

  const retrieval = await prepareTaskContext(memory, task, task_id, deps.queryMemory);
  const driver_return = await deps.invokeDriver({
    task,
    task_id,
    call_id,
    source_driver,
    retrieval,
  });

  const agentContext: AgentContextSnapshot = {
    snapshot_id: randomUUID(),
    source_task_id: task_id,
    agent_id: memory.role_id,
    thinking_trace: `Agent reasoning for ${task_id}: ${retrieval.context_pack.summary}`,
    planning_trace: `Plan: ${task.spec}`,
    driver_calls: [
      {
        call_id,
        driver_id: source_driver,
        driver_return_ref: "report_pending.json",
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
    buffer_snapshot: ingested.snapshot,
    buffer_seq: ingested.seq,
    extraction,
    promotion,
  };
}
