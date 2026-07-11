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
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import { AgentManager } from '../runtime/agent-manager';
import { InMemoryRepository } from '../adapters/in-memory-repository';
import { InMemoryBufferRepository } from '../adapters/in-memory-buffer-repository';
import type { AgentTaskRequest } from '../agent-types';
import type { AgentToolConfig } from '../runtime/agent';

/** 竞标收集测试用 mock toolConfig */
const mockTools: AgentToolConfig = {
  llm: { completeWithTools: async () => ({ content: '', tool_calls: [] }) },
  tools: [],
};

describe('AgentManager.collectCompetitionClaims', () => {
  function createTask(spec: string, task_id = 'task_collect_001'): AgentTaskRequest {
    return { spec, task_id, call_id: 'call_collect_001', source_driver: 'test-driver' };
  }

  describe('basic collection', () => {
    it('多 Agent 并行收集 + 全部返回', async () => {
      const repository = new InMemoryRepository();
      const bufferRepository = new InMemoryBufferRepository();
      const manager = await AgentManager.create(repository, bufferRepository, { tools: mockTools });

      await manager.createAgent({ role_id: 'role_collect_a', name: 'Agent A', tags: ['relevant'] });
      await manager.createAgent({ role_id: 'role_collect_b', name: 'Agent B', tags: ['relevant'] });
      // dispatchTask 即可，无需 start()

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
      const manager = await AgentManager.create(repository, bufferRepository, { tools: mockTools });

      // 逆序创建，期望输出按字母升序
      await manager.createAgent({ role_id: 'role_z', name: 'Z Agent', tags: [] });
      await manager.createAgent({ role_id: 'role_a', name: 'A Agent', tags: [] });
      await manager.createAgent({ role_id: 'role_m', name: 'M Agent', tags: [] });

      const batch = await manager.collectCompetitionClaims(createTask('A task to test ordering'));

      expect(batch.claims).toHaveLength(3);
      expect(batch.claims[0]!.role_id).toBe('role_a');
      expect(batch.claims[1]!.role_id).toBe('role_m');
      expect(batch.claims[2]!.role_id).toBe('role_z');
    });
  });

  describe('unavailable agents', () => {
    it('运行中 Agent 不被收集（只返回可参选 Agent）', async () => {
      const repository = new InMemoryRepository();
      const bufferRepository = new InMemoryBufferRepository();
      const manager = await AgentManager.create(repository, bufferRepository, { tools: mockTools });

      await manager.createAgent({ role_id: 'role_busy', name: 'Busy', tags: [] });
      await manager.createAgent({ role_id: 'role_idle2', name: 'Idle', tags: [] });

      // 让 role_busy 进入 running 状态
      const busyAgent = manager.getAgent('role_busy')!;
      (busyAgent as any).assignTask(createTask('busy task', 'task_busy'));

      // collectCompetitionClaims 只返回 participate 的 Agent
      const batch = await manager.collectCompetitionClaims(createTask('relevant task'));

      // role_busy 是 running 状态 → unavailable → 不返回
      // role_idle2 是 idle 状态 → participate → 返回
      expect(batch.claims).toHaveLength(1);
      expect(batch.claims[0]!.role_id).toBe('role_idle2');
      expect(batch.claims[0]!.decision).toBe('participate');
    });
  });

  describe('preload on create', () => {
    it('创建 AgentManager 时自动从 Repository 加载已注册的 Agent', async () => {
      const repository = new InMemoryRepository();
      const bufferRepository = new InMemoryBufferRepository();

      // 先在 Repository 中注册 Agent
      await repository.initializeAgent({
        role_id: 'role_preload',
        name: 'Preloaded Agent',
        tags: [],
      });
      await bufferRepository.ensureAgent('role_preload');

      // 创建 Manager 时自动加载
      const manager = await AgentManager.create(repository, bufferRepository, { tools: mockTools });

      // Manager 已有这个 Agent 的实例
      expect(manager.getAgent('role_preload')).toBeDefined();

      const batch = await manager.collectCompetitionClaims(createTask('relevant task'));

      expect(batch.claims).toHaveLength(1);
      expect(batch.claims[0]!.role_id).toBe('role_preload');
      expect(batch.claims[0]!.decision).toBe('participate');
    });
  });

  describe('side-effect-free', () => {
    it('收集不改变 Agent 状态（不进入 running）', async () => {
      const repository = new InMemoryRepository();
      const bufferRepository = new InMemoryBufferRepository();
      const manager = await AgentManager.create(repository, bufferRepository, { tools: mockTools });

      await manager.createAgent({ role_id: 'role_safe', name: 'Safe Agent', tags: [] });
      // dispatchTask 即可，无需 start()

      // 收集前应是 idle（Agent 默认状态）
      const agent = manager.getAgent('role_safe')!;
      expect(agent.getState()).toBe('idle');

      await manager.collectCompetitionClaims(createTask('relevant task'));

      // 收集后仍是 idle（未进入 running）
      expect(agent.getState()).toBe('idle');
    });
  });

  describe('participate and decline mix', () => {
    it('只返回参选（participate）的 Agent，拒绝的 Agent 不呈递', async () => {
      const repository = new InMemoryRepository();
      const bufferRepository = new InMemoryBufferRepository();
      const manager = await AgentManager.create(repository, bufferRepository, { tools: mockTools });

      await manager.createAgent({ role_id: 'role_a', name: 'Agent A', tags: [] });
      await manager.createAgent({ role_id: 'role_b', name: 'Agent B', tags: [] });

      // 任务不包含 specialized 关键字 → 默认 participate
      const batch = await manager.collectCompetitionClaims(
        createTask('A generic task suitable for everyone'),
      );

      // 所有 Agent 都 participate → 全部返回
      expect(batch.claims).toHaveLength(2);

      // 带有 irrelevant 关键字的任务 → 全部 decline → 空结果
      const emptyBatch = await manager.collectCompetitionClaims(
        createTask('This task is irrelevant for me'),
      );
      expect(emptyBatch.claims).toHaveLength(0);
    });
  });
});
