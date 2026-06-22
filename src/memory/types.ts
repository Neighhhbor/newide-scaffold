/**
 * 记忆流程组合类型
 *
 * 由 Spec 实体组合而成的流程结果：提取输出、晋升检查、完整任务记忆周期（MemoryCycleResult）等。
 * 不含 MVP 便利类型；供 services 与 Agent.runOnce 返回值使用。
 */
import type {
  BufferSnapshot,
  ExperienceRecord,
  ExtractResult,
  PersonaDef,
  SkillRecord,
} from "./schemas";
import type { MemoryRetrievalResult } from "./services/memory-query";

/** 经验提取操作的输出：提取出的经验记录 + 摘要统计 */
export interface ExtractionOutput {
  experiences: ExperienceRecord[];
  result: ExtractResult;
}

/** 晋升检查结果：是否 eligible、是否自动批准、原因列表 */
export interface PromotionCheckResult {
  eligible: boolean;
  auto_approved: boolean;
  reasons: string[];
  blocking_rules: string[];
}

/** 晋升操作完整结果：检查结果 + 若晋升成功则附带 SkillRecord */
export interface PromotionOutcome {
  check: PromotionCheckResult;
  skill?: SkillRecord;
}

/** runTaskMemoryCycle 的完整返回结果 */
export interface MemoryCycleResult {
  agent_id: string;
  persona: PersonaDef;
  skills_before: SkillRecord[];
  retrieval: MemoryRetrievalResult;
  buffer_snapshot: BufferSnapshot;
  buffer_seq: number;
  extraction: ExtractionOutput;
  promotion: PromotionOutcome;
}

export type { MemoryRetrievalResult } from "./services/memory-query";
