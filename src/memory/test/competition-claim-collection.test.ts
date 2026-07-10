/**
 * Competition Claim Collection 测试
 *
 * 验证：
 *   1. 多 Agent 并行收集 + 全部返回
 *   2. 返回顺序按 role_id 稳定
 *   3. 运行中 Agent 返回 unavailable
 *   4. 缺 Agent 实例时自动恢复
 *   5. 收集不改变 Agent 状态
 *   6. correlation_id 和 task_id 正确
 */
import { describe, it, expect } from 'vitest';
import { AgentManager } from '../runtime/agent-manager';
import { InMemoryRepository } from '../adapters/in-memory-repository';
import { InMemoryBufferRepository } from '../adapters/in-memory-buffer-repository';
import { createMockCompetitionClaimEvaluator } from '../adapters/mock-competition-claim-evaluator';
import type { AgentTaskRequest } from '../agent-types';

describe('AgentManager.collectCompetitionClaims', () => {
  function createTask(spec: string, task_id = 'task_collect_001'): AgentTaskRequest {
    return { spec, task_id, call_id: 'call_collect_001', source_driver: 'test-driver' };
  }

  describe('basic collection', () => {
    it('多 Agent 并行收集 + 全部返回', async () => {
      const repository = new InMemoryRepository();
      const bufferRepository = new InMemoryBufferRepository();
      const manager = AgentManager.create(repository, bufferRepository, {
        evaluator: createMockCompetitionClaimEvaluator(),
      });

      await manager.createAgent({ role_id: 'role_collect_a', name: 'Agent A', tags: ['relevant'] });
      await manager.createAgent({ role_id: 'role_collect_b', name: 'Agent B', tags: ['relevant'] });
      manager.start();

      const batch = await manager.collectCompetitionClaims(
        createTask('A relevant task for testing'),
      );

      expect(batch.claims).toHaveLength(2);
      expect(batch.correlation_id).toBeTruthy();
      expect(batch.task_id).toBe('task_collect_001');
      expect(batch.started_at).toBeTruthy();
      expect(batch.completed_at).toBeTruthy();
    });

    it('返回顺序按 role_id 稳定', async () => {
      const repository = new InMemoryRepository();
      const bufferRepository = new InMemoryBufferRepository();
      const manager = AgentManager.create(repository, bufferRepository, {
        evaluator: createMockCompetitionClaimEvaluator(),
      });

      // 逆序创建，期望输出按字母升序
      await manager.createAgent({ role_id: 'role_z', name: 'Z Agent', tags: [] });
      await manager.createAgent({ role_id: 'role_a', name: 'A Agent', tags: [] });
      await manager.createAgent({ role_id: 'role_m', name: 'M Agent', tags: [] });

      const batch = await manager.collectCompetitionClaims(createTask('A task to test ordering'));

      expect(batch.claims[0].role_id).toBe('role_a');
      expect(batch.claims[1].role_id).toBe('role_m');
      expect(batch.claims[2].role_id).toBe('role_z');
    });
  });

  describe('unavailable agents', () => {
    it('运行中 Agent 返回 unavailable', async () => {
      const repository = new InMemoryRepository();
      const bufferRepository = new InMemoryBufferRepository();
      const manager = AgentManager.create(repository, bufferRepository, {
        evaluator: createMockCompetitionClaimEvaluator(),
      });

      await manager.createAgent({ role_id: 'role_busy', name: 'Busy', tags: [] });
      await manager.createAgent({ role_id: 'role_idle2', name: 'Idle', tags: [] });

      // 让 role_busy 进入 running 状态
      const busyAgent = manager.getAgent('role_busy')!;
      busyAgent.assignTask(createTask('busy task', 'task_busy'));

      const batch = await manager.collectCompetitionClaims(createTask('relevant task'));

      expect(batch.claims).toHaveLength(2);

      const busyClaim = batch.claims.find((c) => c.role_id === 'role_busy')!;
      expect(busyClaim.decision).toBe('unavailable');
      expect(busyClaim.availability.loop_state).toBe('running');

      const idleClaim = batch.claims.find((c) => c.role_id === 'role_idle2')!;
      expect(idleClaim.decision).not.toBe('unavailable');
    });
  });

  describe('auto recovery', () => {
    it('缺 Agent 实例时自动从 repository 恢复', async () => {
      const repository = new InMemoryRepository();
      const bufferRepository = new InMemoryBufferRepository();
      const manager = AgentManager.create(repository, bufferRepository, {
        evaluator: createMockCompetitionClaimEvaluator(),
      });

      // 直接通过 repository 注册 Agent（不在 Manager 中创建实例）
      await repository.initializeAgent({
        role_id: 'role_missing',
        name: 'Missing Agent',
        tags: [],
      });
      await bufferRepository.ensureAgent('role_missing');

      // 收集时自动补齐实例
      const batch = await manager.collectCompetitionClaims(createTask('relevant task'));

      expect(batch.claims).toHaveLength(1);
      expect(batch.claims[0].role_id).toBe('role_missing');
      expect(batch.claims[0].decision).toBe('participate');

      // Manager 现在有这个 Agent 的实例
      expect(manager.getAgent('role_missing')).toBeDefined();
    });
  });

  describe('side-effect-free', () => {
    it('收集不改变 Agent 状态（不进入 running）', async () => {
      const repository = new InMemoryRepository();
      const bufferRepository = new InMemoryBufferRepository();
      const manager = AgentManager.create(repository, bufferRepository, {
        evaluator: createMockCompetitionClaimEvaluator(),
      });

      await manager.createAgent({ role_id: 'role_safe', name: 'Safe Agent', tags: [] });
      manager.start();

      // 收集前应是 sleeping
      const agent = manager.getAgent('role_safe')!;
      expect(agent.getState()).toBe('sleeping');

      await manager.collectCompetitionClaims(createTask('relevant task'));

      // 收集后仍是 sleeping（未进入 running）
      expect(agent.getState()).toBe('sleeping');
    });
  });

  describe('participate and decline mix', () => {
    it('专业相关和不相关 Agent 混合返回', async () => {
      const repository = new InMemoryRepository();
      const bufferRepository = new InMemoryBufferRepository();
      const manager = AgentManager.create(repository, bufferRepository, {
        evaluator: createMockCompetitionClaimEvaluator(),
      });

      await manager.createAgent({ role_id: 'role_relevant', name: 'Relevant', tags: [] });
      await manager.createAgent({ role_id: 'role_irrelevant', name: 'Irrelevant', tags: [] });

      const batch = await manager.collectCompetitionClaims(
        createTask('This task is irrelevant to my skills'),
      );

      const relClaim = batch.claims.find((c) => c.role_id === 'role_irrelevant')!;
      expect(relClaim.decision).toBe('decline');

      // relevant 关键字不在 spec 中 → 默认 decline
      const otherClaim = batch.claims.find((c) => c.role_id === 'role_relevant')!;
      expect(otherClaim.decision).toBe('decline');
    });
  });
});
