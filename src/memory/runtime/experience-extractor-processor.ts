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
import type { AgentMemoryScope } from '../ports/agent-memory-scope';
import type { BufferTriggerPolicy } from '../ports/buffer-trigger-policy';
import type { ExperienceExtractor } from '../ports/experience-extractor';
import type { ProcessPendingResult } from '../services/memory-cycle';

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
  private async extractOne(memory: AgentMemoryScope, seq: number): Promise<ProcessPendingResult> {
    const pending = await memory.getPendingBuffer(seq);
    if (!pending) {
      throw new Error(`Pending buffer not found: seq=${seq}`);
    }

    const extraction = await this.extractor.extract(pending.snapshot, pending.agentContext);

    for (const experience of extraction.experiences) {
      await memory.saveExperience(experience);
    }

    await memory.markBufferProcessed(seq);

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
