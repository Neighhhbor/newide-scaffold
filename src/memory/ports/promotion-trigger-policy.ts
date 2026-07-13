/**
 * PromotionTriggerPolicy 端口
 *
 * 决定何时对 Agent 的未晋升经验执行技能晋升检查。
 * 独立于 BufferTriggerPolicy；提取和晋升是两次独立的触发。
 *
 * 晋升触发条件（由各实现定义）：
 * - 容量门控：eligible_count >= 阈值
 * - 高信门控：存在 confidence > 高置信阈值的候选
 * - 时间门控：距离上次晋升超过最大等待时间
 */
export interface PromotionTriggerPolicy {
  /** 判断当前是否应触发技能晋升 */
  shouldPromote(input: {
    /** 目标 Agent ID */
    role_id: string;
    /** 当前符合条件的经验数 (type=positive, confidence>0.95, !promoted_to) */
    eligible_count: number;
    /** 是否存在 high-confidence (e.g. > 0.98) 的候选 */
    has_high_confidence: boolean;
    /** 最近一次晋升时间（null 表示从未晋升过） */
    last_promotion_at: Date | null;
  }): boolean;
}
