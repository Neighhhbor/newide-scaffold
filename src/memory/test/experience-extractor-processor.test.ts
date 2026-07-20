/**
 * ExperienceExtractorProcessor 测试
 *
 * 验证：
 *   1. extractAll 处理所有 pending buffer
 *   2. extractAll 空 pending 返回空
 *   3. checkAndExtract 满足 policy 时处理
 *   4. checkAndExtract 不满足 policy 时跳过
 *   5. extractOne 抛出 missing buffer 错误
 */
import { describe, it, expect, vi } from 'vitest';
import { InMemoryRepository } from '../adapters/in-memory-repository';
import { InMemoryBufferRepository } from '../adapters/in-memory-buffer-repository';
import { createAgentMemoryScope } from '../adapters/agent-memory-scope';
import { AlwaysExtractPolicy } from '../adapters/always-extract-policy';
import { BatchBufferTriggerPolicy } from '../adapters/batch-buffer-trigger-policy';
import { ExperienceExtractorProcessor } from '../runtime/experience-extractor-processor';
import type { ExperienceExtractor } from '../ports/experience-extractor';
import type { BufferSnapshot } from '../schemas';
import type { ExtractionOutput } from '../types';

// ──────────────────────────────────────────────
// Mock ExperienceExtractor
// ──────────────────────────────────────────────

function createMockExtractor(experiencesPerCall: number = 1): ExperienceExtractor {
  return {
    extract: vi.fn().mockResolvedValue({
      experiences: Array.from({ length: experiencesPerCall }, (_, i) => ({
        id: `exp-${Date.now()}-${i}`,
        description: `Test experience ${i}`,
        description_embedding: [0.1, 0.2, 0.3],
        content: `Content ${i}`,
        confidence: 0.8,
        tags: ['test'],
        agent_id: 'role_test',
        type: 'positive' as const,
        confidence_history: [],
        referenced_count: 0,
        source_task_id: 'task_001',
        source_driver: 'test-driver',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })),
      result: {
        experiences_created: experiencesPerCall,
        experiences_updated: 0,
        negative_experiences: 0,
        skills_promoted: 0,
      },
    } satisfies ExtractionOutput),
  };
}

// ──────────────────────────────────────────────
// 测试基础设施
// ──────────────────────────────────────────────

async function createTestInfra(role_id = 'role_extract_test') {
  const repository = new InMemoryRepository();
  const bufferRepository = new InMemoryBufferRepository();
  await repository.initializeAgent({ role_id, name: 'Test Agent', tags: [] });
  await bufferRepository.ensureAgent(role_id);
  const memory = createAgentMemoryScope(repository, bufferRepository, role_id);
  return { repository, bufferRepository, memory, role_id };
}

async function writePendingBuffer(
  memory: ReturnType<typeof createAgentMemoryScope>,
  task_id = 'task_001',
) {
  const snapshot: BufferSnapshot = {
    task_id,
    task_description: `Test task ${task_id}`,
    driver_return: {
      artifacts: [],
      summary: 'Done',
      decisions: [],
      blockers: [],
      assumptions: [],
      referenced_experiences: [],
      effectiveness: 'fully_effective',
    },
    source_task_id: task_id,
    source_driver: 'test-driver',
    received_at: new Date().toISOString(),
    retry_count: 0,
    extraction_status: 'pending',
  };
  const saved = await memory.saveBufferSnapshot(snapshot);
  return { seq: saved.seq, snapshot: saved.snapshot };
}

// ──────────────────────────────────────────────
// 测试用例
// ──────────────────────────────────────────────

describe('ExperienceExtractorProcessor', () => {
  describe('extractAll — 手动模式', () => {
    it('处理所有 pending buffer 并返回提取结果', async () => {
      const { memory } = await createTestInfra('role_extract_all');
      const extractor = createMockExtractor(1);
      const processor = new ExperienceExtractorProcessor(new AlwaysExtractPolicy(), extractor);

      // 写入 2 条 pending buffer
      await writePendingBuffer(memory, 'task_001');
      await writePendingBuffer(memory, 'task_002');

      const results = await processor.extractAll(memory);

      expect(results).toHaveLength(2);
      expect(results[0]!.extraction.experiences).toHaveLength(1);
      expect(results[1]!.extraction.experiences).toHaveLength(1);
      // 晋升被跳过
      expect(results[0]!.promotion.check.eligible).toBe(false);
      expect(results[0]!.promotion.check.reasons).toContain(
        'Promotion deferred to SkillPromotionProcessor',
      );

      // buffer 应已被标记为 processed
      const seqs = await memory.listPendingBufferSeqs();
      expect(seqs).toHaveLength(0);
    });

    it('没有 pending buffer 时返回空数组', async () => {
      const { memory } = await createTestInfra('role_extract_empty');
      const processor = new ExperienceExtractorProcessor(
        new AlwaysExtractPolicy(),
        createMockExtractor(1),
      );

      const results = await processor.extractAll(memory);
      expect(results).toHaveLength(0);
    });
  });

  describe('checkAndExtract — 自动模式', () => {
    it('policy 满足条件时提取', async () => {
      const { memory } = await createTestInfra('role_check_ok');
      const extractor = createMockExtractor(1);
      // batchSize=2, 写入3条 => 容量门控触发
      const policy = new BatchBufferTriggerPolicy(2, 3600000);
      const processor = new ExperienceExtractorProcessor(policy, extractor);

      await writePendingBuffer(memory, 'task_001');
      await writePendingBuffer(memory, 'task_002');
      await writePendingBuffer(memory, 'task_003');

      const results = await processor.checkAndExtract(memory);
      expect(results).toHaveLength(3);

      // buffer 已处理
      const seqs = await memory.listPendingBufferSeqs();
      expect(seqs).toHaveLength(0);
    });

    it('policy 不满足条件时跳过', async () => {
      const { memory } = await createTestInfra('role_check_skip');
      const extractor = createMockExtractor(1);
      // batchSize=10, 仅1条 => 容量门控不触发
      const policy = new BatchBufferTriggerPolicy(10, 3600000);
      const processor = new ExperienceExtractorProcessor(policy, extractor);

      await writePendingBuffer(memory, 'task_001');

      const results = await processor.checkAndExtract(memory);
      expect(results).toHaveLength(0);

      // buffer 没有被处理
      const seqs = await memory.listPendingBufferSeqs();
      expect(seqs).toHaveLength(1);
    });

    it('没有 pending buffer 时返回空数组', async () => {
      const { memory } = await createTestInfra('role_check_none');
      const processor = new ExperienceExtractorProcessor(
        new AlwaysExtractPolicy(),
        createMockExtractor(1),
      );

      const results = await processor.checkAndExtract(memory);
      expect(results).toHaveLength(0);
    });
  });

  describe('错误处理', () => {
    it('提取不存在的 buffer 时抛出错误', async () => {
      const { memory } = await createTestInfra('role_extract_err');
      const processor = new ExperienceExtractorProcessor(
        new AlwaysExtractPolicy(),
        createMockExtractor(1),
      );

      await expect(processor.extractOne(memory, 999)).rejects.toThrow(
        'Pending buffer not found: seq=999',
      );
    });

    it('rejects conflicting content for a deterministic replay id', async () => {
      const { memory } = await createTestInfra('role_extract_collision');
      const processor = new ExperienceExtractorProcessor(
        new AlwaysExtractPolicy(),
        createMockExtractor(1),
      );
      const { seq } = await writePendingBuffer(memory, 'task_collision');
      const first = await processor.extractOne(memory, seq);
      const conflicting: ExtractionOutput = {
        experiences: first.extraction.experiences.map((experience) => ({
          ...experience,
          content: 'Different replay content',
        })),
        result: { ...first.extraction.result },
      };

      await expect(
        processor.extractOne(memory, seq, {
          preparedExtraction: conflicting,
          allowMissingPending: true,
        }),
      ).rejects.toThrow('Experience id collision with different content');
    });
  });
});
