/**
 * Memory 全链路集成测试
 *
 * 验证 submitTask 完整周期：
 * repository 检索 → planTaskInstruction → mock Driver → buffer → 提取 → 晋升。
 */
import { describe, it, expect } from 'vitest';
import { AgentManager } from '../runtime/agent-manager';
import { InMemoryRepository } from '../adapters/in-memory-repository';

describe('memory MVP demo flow', () => {
  it('createAgent → submitTask → 检索 → mock Driver → buffer → 提取 → 默认不晋升', async () => {
    const repository = new InMemoryRepository();
    const manager = AgentManager.create(repository);

    await manager.createAgent({
      role_id: 'role_ts_engineer',
      name: 'TypeScript Engineer',
      tags: ['typescript'],
    });
    manager.start();

    const task_id = 'task_mvp_001';
    const call_id = 'call_mvp_001';

    const result = await manager.submitTask({
      spec: 'Implement memory input MVP.',
      task_id,
      call_id,
      source_driver: 'mock-driver',
    });

    expect(result.winner_role_id).toBe('role_ts_engineer');
    expect(result.cycle.buffer_snapshot.task_id).toBe(task_id);
    expect(result.cycle.extraction.experiences).toHaveLength(1);
    expect(result.cycle.promotion.check.eligible).toBe(false);

    expect(result.cycle.driver_context.task_instruction).toBe(
      'Execute the driver task according to the planned scope.',
    );
    expect(result.cycle.driver_context.experiences).toEqual([]);
    expect(result.cycle.driver_context.skills).toEqual([]);

    const meta = await repository.getBufferMeta('role_ts_engineer');
    expect(meta.pending_count).toBe(0);
    expect(meta.total_processed).toBe(1);

    const experiences = await repository.listExperiences('role_ts_engineer');
    expect(experiences).toHaveLength(1);
    expect(experiences[0]?.source_task_id).toBe(task_id);
  });

  it('promotion_ready scenario → mock 技能晋升', async () => {
    const repository = new InMemoryRepository();
    const manager = AgentManager.create(repository);

    await manager.createAgent({
      role_id: 'role_promo',
      name: 'Promotion Demo Agent',
    });
    manager.start();

    const result = await manager.submitTask({
      spec: 'Trigger mock skill promotion.',
      task_id: 'task_promo_001',
      scenario: 'promotion_ready',
    });

    expect(result.cycle.promotion.check.eligible).toBe(true);
    expect(result.cycle.promotion.skill).toBeDefined();
    expect(result.cycle.extraction.result.skills_promoted).toBe(1);

    const skills = await repository.listSkills('role_promo');
    expect(skills).toHaveLength(1);

    const experiences = await repository.listExperiences('role_promo');
    expect(experiences[0]?.promoted_to).toBe(skills[0]?.id);
  });
});
