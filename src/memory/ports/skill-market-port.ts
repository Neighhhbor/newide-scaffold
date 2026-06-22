/**
 * SkillMarketPort 端口
 *
 * 全局技能市场检索：相似技能搜索、已批准技能列表。用于晋升冲突检测与跨 Agent 引入技能。
 */
import type { SkillRecord } from "../schemas";

/**
 * 技能市场单条检索结果
 */
export interface SkillMarketSearchResult {
  /** 检索到的技能记录 */
  skill: SkillRecord;
  /** 与查询向量的余弦相似度（0~1） */
  similarity: number;
}

export interface SkillMarketPort {
  /** 检索市场中与 query 最相似的技能 */
  searchSimilar(
    descriptionEmbedding: number[],
    opts?: { threshold?: number; limit?: number },
  ): Promise<SkillMarketSearchResult[]>;

  /** 列出已批准的技能（可按 Agent 筛选） */
  listApprovedSkills(agent_id?: string): Promise<SkillRecord[]>;
}
