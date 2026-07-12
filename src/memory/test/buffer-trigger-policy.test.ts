/**
 * BufferTriggerPolicy 测试
 *
 * 验证：
 *   1. BatchBufferTriggerPolicy 三层门控（容量/时间/优先级）
 *   2. AlwaysExtractPolicy 始终返回 true
 */
import { describe, it, expect } from 'vitest';
import { BatchBufferTriggerPolicy } from '../adapters/batch-buffer-trigger-policy';
import { AlwaysExtractPolicy } from '../adapters/always-extract-policy';
import type { BufferMeta, BufferSnapshot, DriverReturn } from '../schemas';

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function createMeta(overrides: Partial<BufferMeta> = {}): BufferMeta {
  return {
    role_id: 'role_test',
    pending_count: 0,
    cursor: 0,
    total_processed: 0,
    total_dead_letters: 0,
    ...overrides,
  };
}

function createSnapshot(
  overrides: Partial<BufferSnapshot> & { effectiveness?: DriverReturn['effectiveness'] } = {},
): BufferSnapshot {
  const { effectiveness, ...rest } = overrides;
  return {
    task_id: 'task_001',
    task_description: 'Test task',
    driver_return: {
      artifacts: [],
      summary: 'Done',
      decisions: [],
      blockers: [],
      assumptions: [],
      referenced_experiences: [],
      effectiveness: effectiveness ?? 'fully_effective',
    },
    source_task_id: 'task_001',
    source_driver: 'test-driver',
    received_at: new Date().toISOString(),
    retry_count: 0,
    extraction_status: 'pending',
    ...rest,
  };
}

// ──────────────────────────────────────────────
// BatchBufferTriggerPolicy
// ──────────────────────────────────────────────

describe('BatchBufferTriggerPolicy', () => {
  describe('容量门控', () => {
    it('pending_count >= batchSize 时触发', () => {
      const policy = new BatchBufferTriggerPolicy(3, 3600000);
      const meta = createMeta({ pending_count: 3 });
      const pending = [createSnapshot(), createSnapshot(), createSnapshot()];

      expect(policy.shouldExtract(meta, pending)).toBe(true);
    });

    it('pending_count < batchSize 时不触发', () => {
      const policy = new BatchBufferTriggerPolicy(3, 3600000);
      const meta = createMeta({ pending_count: 2 });
      const pending = [createSnapshot(), createSnapshot()];

      expect(policy.shouldExtract(meta, pending)).toBe(false);
    });
  });

  describe('时间门控', () => {
    it('最老报告超过 maxStalenessMs 时触发', () => {
      const policy = new BatchBufferTriggerPolicy(10, 100); // maxStalenessMs = 100ms
      const meta = createMeta({ pending_count: 1 });
      const oldDate = new Date(Date.now() - 200).toISOString();
      const pending = [createSnapshot({ received_at: oldDate })];

      expect(policy.shouldExtract(meta, pending)).toBe(true);
    });

    it('所有报告都在 maxStalenessMs 以内时不触发', () => {
      const policy = new BatchBufferTriggerPolicy(10, 3600000);
      const meta = createMeta({ pending_count: 1 });
      const pending = [createSnapshot()];

      expect(policy.shouldExtract(meta, pending)).toBe(false);
    });
  });

  describe('优先级门控', () => {
    it('存在 effectiveness = ineffective 的报告时触发', () => {
      const policy = new BatchBufferTriggerPolicy(10, 3600000);
      const meta = createMeta({ pending_count: 1 });
      const pending = [createSnapshot({ effectiveness: 'ineffective' })];

      expect(policy.shouldExtract(meta, pending)).toBe(true);
    });

    it('effectiveness 为 fully_effective 时不触发', () => {
      const policy = new BatchBufferTriggerPolicy(10, 3600000);
      const meta = createMeta({ pending_count: 1 });
      const pending = [createSnapshot({ effectiveness: 'fully_effective' })];

      expect(policy.shouldExtract(meta, pending)).toBe(false);
    });
  });

  describe('组合门控', () => {
    it('多个条件同时满足时仍只返回 true', () => {
      const policy = new BatchBufferTriggerPolicy(3, 100);
      const meta = createMeta({ pending_count: 5 });
      const oldDate = new Date(Date.now() - 200).toISOString();
      const pending = [createSnapshot({ received_at: oldDate, effectiveness: 'ineffective' })];

      expect(policy.shouldExtract(meta, pending)).toBe(true);
    });

    it('无任何条件满足时不触发', () => {
      const policy = new BatchBufferTriggerPolicy(10, 3600000);
      const meta = createMeta({ pending_count: 1 });
      const pending = [createSnapshot()];

      expect(policy.shouldExtract(meta, pending)).toBe(false);
    });
  });
});

// ──────────────────────────────────────────────
// AlwaysExtractPolicy
// ──────────────────────────────────────────────

describe('AlwaysExtractPolicy', () => {
  it('shouldExtract 始终返回 true', () => {
    const policy = new AlwaysExtractPolicy();
    const meta = createMeta({ pending_count: 0 });
    const pending: BufferSnapshot[] = [];

    expect(policy.shouldExtract(meta, pending)).toBe(true);
    expect(policy.shouldExtract(createMeta({ pending_count: 5 }), [createSnapshot()])).toBe(true);
  });
});
