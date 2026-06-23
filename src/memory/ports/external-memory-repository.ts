/**
 * ExternalMemoryRepository 端口
 *
 * 跨 Agent 的记忆检索、按 ID 加载与使用反馈接口（技能市场/协作场景）。
 * 与 MemoryRepository（本 Agent 本地 CRUD）互补；MVP 尚未实现适配器。
 */
import type { ExperienceRecord, SkillRecord } from "../schemas";

/**
 * 记忆条目类型
 * - "experience" — 经验记录（任务反思产物）
 * - "skill"      — 技能记录（晋升后的可复用能力）
 */
export type MemoryItemType = "experience" | "skill";

/**
 * 跨 Agent 记忆检索输入参数
 */
export interface SearchAccessibleMemoriesInput {
  /** 发起检索的 Agent ID（用于权限过滤） */
  requester_agent_id: string;
  /** 检索查询文本（自然语言） */
  query: string;
  /** 限定检索的记忆类型（不传则检索全部） */
  types?: MemoryItemType[];
  /** 返回的最大命中数 */
  top_k?: number;
  /** 最小相似度阈值（0~1，低于此值的结果被过滤） */
  min_similarity?: number;
}

/**
 * 单条检索命中结果
 */
export interface SearchAccessibleMemoryHit {
  /** 记忆条目 ID */
  id: string;
  /** 记忆类型 */
  type: MemoryItemType;
  /** 拥有者 Agent ID */
  owner_agent_id: string;
  /** 记忆描述文本 */
  description: string;
  /** 与查询的相似度分数（0~1） */
  similarity: number;
  /** 允许访问的原因说明（用于可解释性） */
  access_reason: string;
}

/** 检索操作的完整输出 */
export interface SearchAccessibleMemoriesOutput {
  /** 按相似度降序排列的命中结果 */
  hits: SearchAccessibleMemoryHit[];
}

/**
 * 按 ID 批量加载记忆详情的输入参数
 */
export interface LoadAccessibleMemoriesInput {
  /** 发起加载的 Agent ID */
  requester_agent_id: string;
  /** 要加载的记忆条目 ID 和类型列表 */
  items: Array<{ id: string; type: MemoryItemType }>;
}

/**
 * 按 ID 批量加载记忆详情的输出
 */
export interface LoadAccessibleMemoriesOutput {
  /** 成功加载的经验记录 */
  experiences: ExperienceRecord[];
  /** 成功加载的技能记录 */
  skills: SkillRecord[];
  /** 被拒绝访问的条目及原因 */
  denied: Array<{ id: string; type: MemoryItemType; reason: string }>;
}

/**
 * 记忆使用效果反馈的输入参数
 *
 * Agent 在使用外部记忆完成任务后，回写使用效果，
 * 用于更新经验的置信度和引用计数。
 */
export interface RecordMemoryUsageFeedbackInput {
  /** 提供反馈的 Agent ID */
  requester_agent_id: string;
  /** 被评价的经验 ID */
  experience_id: string;
  /** 使用该经验的任务 ID */
  task_id: string;
  /** 该经验在本次任务中的有效性 */
  effectiveness: "fully_effective" | "partially_effective" | "ineffective" | "not_applicable";
  /** 补充说明 */
  note?: string;
}

/**
 * 面向 Agent 的外部记忆访问接口：
 * - search: 带权限过滤的相似度检索
 * - load: 对选中 ID 拉取详情（再次权限校验）
 * - feedback: 回写使用效果（MVP 先固定输入输出）
 */
export interface ExternalMemoryRepository {
  /** 跨 Agent 语义检索已发布的记忆 */
  searchAccessibleMemories(
    input: SearchAccessibleMemoriesInput,
  ): Promise<SearchAccessibleMemoriesOutput>;

  /** 按 ID 批量加载记忆详情（含二次权限校验） */
  loadAccessibleMemories(
    input: LoadAccessibleMemoriesInput,
  ): Promise<LoadAccessibleMemoriesOutput>;

  /** 回写记忆使用效果反馈 */
  recordMemoryUsageFeedback(input: RecordMemoryUsageFeedbackInput): Promise<void>;
}

