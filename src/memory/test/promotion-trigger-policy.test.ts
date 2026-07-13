/**
 * PromotionTriggerPolicy 测试
 *
 * 验证 DefaultPromotionTriggerPolicy 三层门控（容量/高信/时间）。
 */
import { describe, it, expect } from 'vitest';
import { DefaultPromotionTriggerPolicy } from '../adapters/default-promotion-trigger-policy';

// ──────────────────────────────────────────────
// DefaultPromotionTriggerPolicy
// ──────────────────────────────────────────────

describe('DefaultPromotionTriggerPolicy', () => {
  describe('容量门控', () => {
    it('eligible_count >= minEligibleCount (5) 时触发', () => {
      const policy = new DefaultPromotionTriggerPolicy(5, 0.98, 86400000);
      const result = policy.shouldPromote({
        role_id: 'role_test',
        eligible_count: 5,
        has_high_confidence: false,
        last_promotion_at: null,
      });
      expect(result).toBe(true);
    });

    it('eligible_count < minEligibleCount 时不触发', () => {
      const policy = new DefaultPromotionTriggerPolicy(5, 0.98, 86400000);
      const result = policy.shouldPromote({
        role_id: 'role_test',
        eligible_count: 4,
        has_high_confidence: false,
        last_promotion_at: null,
      });
      expect(result).toBe(false);
    });
  });

  describe('高信门控', () => {
    it('has_high_confidence 为 true 时触发', () => {
      const policy = new DefaultPromotionTriggerPolicy(10, 0.98, 86400000);
      const result = policy.shouldPromote({
        role_id: 'role_test',
        eligible_count: 1,
        has_high_confidence: true,
        last_promotion_at: null,
      });
      expect(result).toBe(true);
    });

    it('has_high_confidence 为 false 时不触发', () => {
      const policy = new DefaultPromotionTriggerPolicy(10, 0.98, 86400000);
      const result = policy.shouldPromote({
        role_id: 'role_test',
        eligible_count: 1,
        has_high_confidence: false,
        last_promotion_at: null,
      });
      expect(result).toBe(false);
    });
  });

  describe('时间门控', () => {
    it('距离上次晋升 >= maxStalenessMs 且有候选时触发', () => {
      const policy = new DefaultPromotionTriggerPolicy(10, 0.98, 100); // maxStalenessMs = 100ms
      const longAgo = new Date(Date.now() - 200);
      const result = policy.shouldPromote({
        role_id: 'role_test',
        eligible_count: 1,
        has_high_confidence: false,
        last_promotion_at: longAgo,
      });
      expect(result).toBe(true);
    });

    it('距离上次晋升 < maxStalenessMs 时不触发', () => {
      const policy = new DefaultPromotionTriggerPolicy(10, 0.98, 86400000);
      const recent = new Date();
      const result = policy.shouldPromote({
        role_id: 'role_test',
        eligible_count: 1,
        has_high_confidence: false,
        last_promotion_at: recent,
      });
      expect(result).toBe(false);
    });

    it('从未晋升且 eligible_count=0 时不触发', () => {
      const policy = new DefaultPromotionTriggerPolicy(10, 0.98, 100);
      const result = policy.shouldPromote({
        role_id: 'role_test',
        eligible_count: 0,
        has_high_confidence: false,
        last_promotion_at: null,
      });
      expect(result).toBe(false);
    });
  });

  describe('组合场景', () => {
    it('多个条件同时满足时仍只返回 true', () => {
      const policy = new DefaultPromotionTriggerPolicy(5, 0.98, 100);
      const longAgo = new Date(Date.now() - 200);
      const result = policy.shouldPromote({
        role_id: 'role_test',
        eligible_count: 10,
        has_high_confidence: true,
        last_promotion_at: longAgo,
      });
      expect(result).toBe(true);
    });

    it('无任何条件满足时不触发', () => {
      const policy = new DefaultPromotionTriggerPolicy(10, 0.98, 86400000);
      const recent = new Date();
      const result = policy.shouldPromote({
        role_id: 'role_test',
        eligible_count: 1,
        has_high_confidence: false,
        last_promotion_at: recent,
      });
      expect(result).toBe(false);
    });
  });
});
