/**
 * ExperienceExtractorProcessor — 经验提取处理器
 *
 * 从 pending buffer 中提取经验、保存、标记完成。
 * 不与技能晋升耦合；提取和晋升是两次独立的触发。
 *
 * 两种调用模式：
 *   - extractAll()    : 手动模式，处理所有 pending buffer（不检查 policy）
 *   - checkAndExtract(): 自动模式，先评估 BufferTriggerPolicy，满足条件再处理
 */
import { createHash } from 'node:crypto';
import type { AgentMemoryScope } from '../ports/agent-memory-scope';
import type { BufferTriggerPolicy } from '../ports/buffer-trigger-policy';
import type { ExperienceExtractor } from '../ports/experience-extractor';
import type { ProcessPendingResult } from '../services/memory-cycle';
import type { ExperienceRecord } from '../schemas';
import type { ExtractionOutput } from '../types';

export interface ExtractOneOptions {
  preparedExtraction?: ExtractionOutput;
  allowMissingPending?: boolean;
  onPrepared?: (extraction: ExtractionOutput) => Promise<void>;
  shouldContinue?: () => boolean;
}

export class ExperienceExtractorProcessor {
  constructor(
    private readonly policy: BufferTriggerPolicy,
    private readonly extractor: ExperienceExtractor,
  ) {}

  /**
   * 手动模式：处理所有 pending buffer，不检查触发策略。
   */
  async extractAll(memory: AgentMemoryScope): Promise<ProcessPendingResult[]> {
    const seqs = await memory.listPendingBufferSeqs();
    const results: ProcessPendingResult[] = [];

    for (const seq of seqs) {
      const result = await this.extractOne(memory, seq);
      results.push(result);
    }

    return results;
  }

  /**
   * 自动模式：先评估 BufferTriggerPolicy，满足条件才处理 pending buffer。
   *
   * @returns 已处理的提取结果列表；未触发时返回空数组
   */
  async checkAndExtract(memory: AgentMemoryScope): Promise<ProcessPendingResult[]> {
    const seqs = await memory.listPendingBufferSeqs();
    if (seqs.length === 0) {
      return [];
    }

    const meta = await memory.getBufferMeta();
    const snapshots = await Promise.all(
      seqs.map(async (seq) => {
        const pending = await memory.getPendingBuffer(seq);
        return pending?.snapshot ?? null;
      }),
    );
    const validSnapshots = snapshots.filter((s): s is NonNullable<typeof s> => s !== null);

    if (!this.policy.shouldExtract(meta, validSnapshots)) {
      return [];
    }

    return this.extractAll(memory);
  }

  /**
   * 处理单条 pending buffer：提取经验 → 保存 → 标记 processed。
   * 不做技能晋升。
   */
  async extractOne(
    memory: AgentMemoryScope,
    seq: number,
    options?: ExtractOneOptions,
  ): Promise<ProcessPendingResult> {
    const pending = await memory.getPendingBuffer(seq);
    if (!pending && !(options?.allowMissingPending && options.preparedExtraction)) {
      throw new Error(`Pending buffer not found: seq=${seq}`);
    }

    const rawExtraction =
      options?.preparedExtraction ??
      (await this.extractor.extract(
        pending!.snapshot,
        ...(pending!.agentContext ? [pending!.agentContext] : []),
      ));
    const extraction = normalizeExtraction(rawExtraction, memory.role_id, seq);
    await options?.onPrepared?.(extraction);
    assertContinuation(options);

    const existingById = new Map(
      (await memory.listExperiences()).map((experience) => [experience.id, experience]),
    );

    for (const experience of extraction.experiences) {
      assertContinuation(options);
      const existing = existingById.get(experience.id);
      if (existing) {
        assertSameExperience(existing, experience);
        continue;
      }
      await memory.saveExperience(experience);
      assertContinuation(options);
    }

    if (pending) {
      assertContinuation(options);
      await memory.markBufferProcessed(seq);
    }

    return {
      extraction,
      promotion: {
        check: {
          eligible: false,
          auto_approved: false,
          reasons: ['Promotion deferred to SkillPromotionProcessor'],
          blocking_rules: [],
        },
      },
    };
  }
}

function assertContinuation(options: ExtractOneOptions | undefined): void {
  if (options?.shouldContinue?.() === false) {
    throw new Error('Experience extraction stopped at a maintenance boundary');
  }
}

function normalizeExtraction(
  extraction: ExtractionOutput,
  roleId: string,
  seq: number,
): ExtractionOutput {
  return {
    experiences: extraction.experiences.map((experience, index) => ({
      ...experience,
      id: deterministicExperienceId(roleId, seq, index),
      agent_id: roleId,
    })),
    result: { ...extraction.result },
  };
}

function deterministicExperienceId(roleId: string, seq: number, index: number): string {
  const bytes = createHash('sha256')
    .update(`${roleId}\0${String(seq)}\0${String(index)}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function assertSameExperience(existing: ExperienceRecord, expected: ExperienceRecord): void {
  const comparableExisting = comparableExperience(existing);
  const comparableExpected = comparableExperience(expected);
  if (JSON.stringify(comparableExisting) !== JSON.stringify(comparableExpected)) {
    throw new Error(`Experience id collision with different content: ${expected.id}`);
  }
}

function comparableExperience(experience: ExperienceRecord) {
  return {
    id: experience.id,
    description: experience.description,
    content: experience.content,
    confidence: experience.confidence,
    tags: experience.tags,
    agent_id: experience.agent_id,
    source_task_id: experience.source_task_id,
    source_driver: experience.source_driver,
    type: experience.type,
  };
}
