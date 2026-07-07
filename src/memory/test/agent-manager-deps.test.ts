/**
 * AgentManager 运行时边界测试
 *
 * 验证：
 *   1. AgentManager 向后兼容性（无 options 调用）
 *   2. 通过 AgentManagerOptions.deps 注入自定义 AgentRunDeps
 *   3. 自定义 invokeDriver 在 submitTask 中被正确调用
 *   4. toMemoryTaskProjection 映射正确
 *   5. 默认不晋升 + 晋升就绪两条分支
 */
import { describe, it, expect } from 'vitest';
import { AgentManager, toMemoryTaskProjection } from '../runtime/agent-manager';
import type { MemoryTaskProjection } from '../runtime/agent-manager';
import { InMemoryRepository } from '../adapters/in-memory-repository';
import { InMemoryBufferRepository } from '../adapters/in-memory-buffer-repository';
import { ruleBasedSkillPromotion } from '../services/skill-promotion';
import type { AgentRunDeps } from '../runtime/agent-run-deps';
import type { DriverReturn, BufferSnapshot } from '../schemas';

describe('AgentManager deps injection', () => {
  it('向后兼容：无 options 调用 createAgent → submitTask 正常', async () => {
    const repository = new InMemoryRepository();
    const bufferRepository = new InMemoryBufferRepository();
    const manager = AgentManager.create(repository, bufferRepository);

    await manager.createAgent({
      role_id: 'role_backward',
      name: 'Backward Compat Agent',
      tags: ['compat'],
    });
    manager.start();

    const result = await manager.submitTask({
      spec: 'Test backward compatibility.',
      task_id: 'task_bc_001',
      call_id: 'call_bc_001',
      source_driver: 'mock-driver',
    });

    expect(result.winner_role_id).toBe('role_backward');
    expect(result.cycle.buffer_snapshot.task_id).toBe('task_bc_001');
    expect(result.cycle.extraction.experiences).toHaveLength(1);
  });

  it('通过 options.deps 注入自定义 invokeDriver 并被 submitTask 调用', async () => {
    const repository = new InMemoryRepository();
    const bufferRepository = new InMemoryBufferRepository();
    let invokeCallCount = 0;
    let lastInvokeInput: unknown;
    const invokeDriverFn = async (input: {
      task_id: string;
      call_id: string;
      source_driver: string;
      driver_context: { task_instruction: string };
    }) => {
      invokeCallCount++;
      lastInvokeInput = input;
      const returnValue: DriverReturn = {
        summary: 'Custom driver executed.',
        artifacts: [],
        decisions: [],
        blockers: [],
        referenced_experiences: [],
        assumptions: [],
      };
      return returnValue;
    };

    const customDeps: AgentRunDeps = {
      queryMemory: async () => ({ experiences: [], skills: [] }),
      planTaskInstruction: async () => 'Custom plan instruction',
      invokeDriver: invokeDriverFn,
      extractor: {
        extract: async (_snapshot: BufferSnapshot) => ({
          experiences: [],
          result: {
            experiences_created: 0,
            experiences_updated: 0,
            negative_experiences: 0,
            skills_promoted: 0,
          },
        }),
      },
      promote: async () => ({
        check: {
          eligible: false,
          auto_approved: false,
          reasons: [],
          blocking_rules: ['no high confidence experiences'],
        },
      }),
      contextCleaner: { clean: async () => null },
    };

    const manager = AgentManager.create(repository, bufferRepository, {
      deps: customDeps,
    });

    await manager.createAgent({
      role_id: 'role_custom',
      name: 'Custom Deps Agent',
      tags: ['custom'],
    });
    manager.start();

    const result = await manager.submitTask({
      spec: 'Test custom deps injection.',
      task_id: 'task_custom_001',
      call_id: 'call_custom_001',
      source_driver: 'custom-driver',
    });

    // 验证自定义 invokeDriver 被调用了
    expect(invokeCallCount).toBe(1);
    expect(lastInvokeInput).toBeDefined();
    const invokeInput = lastInvokeInput as {
      task_id: string;
      call_id: string;
      source_driver: string;
      driver_context: { task_instruction: string };
    };
    expect(invokeInput.task_id).toBe('task_custom_001');
    expect(invokeInput.call_id).toBe('call_custom_001');
    expect(invokeInput.source_driver).toBe('custom-driver');
    expect(invokeInput.driver_context.task_instruction).toBe('Custom plan instruction');

    // 验证 cycle 中的数据
    expect(result.cycle.buffer_snapshot.driver_return.summary).toBe('Custom driver executed.');

    // 验证 write pending buffer 流程正常（不提取经验——extractor 返回空列表）
    const meta = await bufferRepository.getBufferMeta('role_custom');
    expect(meta.pending_count).toBe(0);
    expect(meta.total_processed).toBe(1);
  });

  it('toMemoryTaskProjection 默认不晋升分支', async () => {
    const repository = new InMemoryRepository();
    const bufferRepository = new InMemoryBufferRepository();
    const manager = AgentManager.create(repository, bufferRepository);

    await manager.createAgent({
      role_id: 'role_proj_default',
      name: 'Projection Agent',
      tags: ['proj'],
    });
    manager.start();

    const result = await manager.submitTask({
      spec: 'Test projection mapping.',
      task_id: 'task_proj_001',
      call_id: 'call_proj_001',
      source_driver: 'mock-driver',
    });

    const projection: MemoryTaskProjection = toMemoryTaskProjection(result);

    // 基本字段
    expect(projection.task_id).toBe('task_proj_001');
    expect(projection.winner_role_id).toBe('role_proj_default');
    expect(projection.scores).toEqual({ role_proj_default: 0.5 });

    // driver_summary 来自 buffer_snapshot.driver_return.summary
    expect(projection.driver_summary).toBeTruthy();
    expect(typeof projection.driver_summary).toBe('string');

    // context 统计
    expect(projection.context.skill_count).toBe(0);
    expect(projection.context.experience_count).toBe(0);

    // 默认不晋升
    expect(projection.extraction.experiences_created).toBe(1);
    expect(projection.extraction.skills_promoted).toBe(0);
    expect(projection.promoted_skill_ids).toEqual([]);

    // buffer_seq
    expect(projection.buffer_seq).toBe(result.cycle.buffer_seq);

    // 不暴露 repository/buffer 实例
    const projRecord = projection as Record<string, unknown>;
    expect(projRecord.repository).toBeUndefined();
    expect(projRecord.bufferRepository).toBeUndefined();
  });

  it('toMemoryTaskProjection 晋升就绪分支', async () => {
    const repository = new InMemoryRepository();
    const bufferRepository = new InMemoryBufferRepository();
    const role_id = 'role_proj_promo';
    const now = new Date().toISOString();

    const customDeps: AgentRunDeps = {
      queryMemory: async () => ({ experiences: [], skills: [] }),
      planTaskInstruction: async () => 'Execute promotion test.',
      invokeDriver: async () => ({
        summary: 'Task completed.',
        artifacts: [],
        decisions: [],
        blockers: [],
        referenced_experiences: [
          {
            experience_id: 'exp_high_conf',
            applied: true,
            effectiveness: 'fully_effective',
            note: '',
          },
        ],
        assumptions: [],
      }),
      extractor: {
        extract: async (snapshot: BufferSnapshot) => ({
          experiences: [
            {
              id: 'exp_new_001',
              description: 'New experience from promotion test',
              description_embedding: [0.1, 0.2, 0.3],
              content: 'Best practice for scenario Z',
              confidence: 0.96,
              tags: ['best-practice'],
              agent_id: role_id,
              confidence_history: [],
              referenced_count: 0,
              source_task_id: snapshot.task_id,
              source_driver: snapshot.source_driver,
              type: 'positive',
              created_at: now,
              updated_at: now,
            },
          ],
          result: {
            experiences_created: 1,
            experiences_updated: 0,
            negative_experiences: 0,
            skills_promoted: 0,
          },
        }),
      },
      promote: ruleBasedSkillPromotion,
      contextCleaner: { clean: async () => null },
    };

    // 使用 create 通过 options.deps 注入（manager.createAgent 内部会调用 initializeAgent）
    const manager = AgentManager.create(repository, bufferRepository, { deps: customDeps });
    await manager.createAgent({ role_id, name: 'Promo Projection Agent', tags: [] });
    manager.start();

    // 预置一条高置信度经验用于晋升
    await repository.saveExperience(role_id, {
      id: 'exp_high_conf',
      description: 'High confidence experience for promotion',
      description_embedding: [0.1, 0.2, 0.3],
      content: 'Use approach X for problem category Y',
      confidence: 0.96,
      tags: ['approach'],
      agent_id: role_id,
      confidence_history: [],
      referenced_count: 0,
      source_task_id: 'task_prep_001',
      source_driver: 'mock-driver',
      type: 'positive',
      created_at: now,
      updated_at: now,
    });

    const result = await manager.submitTask({
      spec: 'Trigger promotion and test projection.',
      task_id: 'task_proj_promo_001',
      call_id: 'call_proj_promo_001',
      source_driver: 'mock-driver',
      scenario: 'promotion_ready',
    });

    const projection: MemoryTaskProjection = toMemoryTaskProjection(result);

    expect(projection.task_id).toBe('task_proj_promo_001');
    expect(projection.winner_role_id).toBe(role_id);

    // 晋升分支
    expect(projection.extraction.experiences_created).toBe(1);
    expect(projection.extraction.skills_promoted).toBe(1);
    expect(projection.promoted_skill_ids).toHaveLength(1);
    expect(typeof projection.promoted_skill_ids[0]).toBe('string');

    // context 字段
    expect(typeof projection.context.skill_count).toBe('number');
    expect(typeof projection.context.experience_count).toBe('number');

    // buffer_seq
    expect(projection.buffer_seq).toBeGreaterThanOrEqual(1);
  });
});
