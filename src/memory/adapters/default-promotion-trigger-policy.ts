/**
 * DefaultPromotionTriggerPolicy — PromotionTriggerPolicy 默认实现
 *
 * 三层触发门控：
 *   1. 容量门控：eligible_count >= 5
 *   2. 高信门控：存在 confidence > 0.98 的候选
 *   3. 时间门控：距离上次晋升 >= 24h 且至少有一个候选
 *
 * 任一条件满足即触发晋升。
 */
import type { PromotionTriggerPolicy } from '../ports/promotion-trigger-policy';

export class DefaultPromotionTriggerPolicy implements PromotionTriggerPolicy {
  constructor(
    private readonly minEligibleCount = 5,
    private readonly highConfidenceThreshold = 0.98,
    private readonly maxStalenessMs = 24 * 60 * 60 * 1000,
  ) {}

  shouldPromote(input: {
    role_id: string;
    eligible_count: number;
    has_high_confidence: boolean;
    last_promotion_at: Date | null;
  }): boolean {
    // 1. 容量门控
    if (input.eligible_count >= this.minEligibleCount) {
      return true;
    }

    // 2. 高信门控
    if (input.has_high_confidence) {
      return true;
    }

    // 3. 时间门控
    if (
      input.last_promotion_at !== null &&
      Date.now() - input.last_promotion_at.getTime() >= this.maxStalenessMs &&
      input.eligible_count >= 1
    ) {
      return true;
    }

    return false;
  }
}
