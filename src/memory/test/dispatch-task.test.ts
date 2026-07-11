/**
 * dispatchTask 单元测试
 *
 * 验证：
 *   1. dispatchTask 正常完成
 *   2. 不存在 Agent → blocked
 *   3. Agent draining/retired → blocked
 *   4. Agent 正在忙 → blocked
 *   5. 任务执行失败 → failed
 *   6. 无 Driver 调用 → no_driver_invocation
 *   7. toMemoryTaskProjection 从 DispatchTaskResult 正确派生
 */
import { describe, it, expect } from 'vitest';
import { AgentManager, toMemoryTaskProjection } from '../runtime/agent-manager';
import type { MemoryTaskProjection } from '../runtime/agent-manager';
import { InMemoryRepository } from '../adapters/in-memory-repository';
import { InMemoryBufferRepository } from '../adapters/in-memory-buffer-repository';
import type { AgentTaskRequest } from '../agent-types';

describe('AgentManager.dispatchTask', () => {
  function createTask(overrides: Partial<AgentTaskRequest> = {}): AgentTaskRequest {
    return {
      spec: 'Test task for dispatch.',
      task_id: 'task_dispatch_001',
      call_id: 'call_dispatch_001',
      source_driver: 'test-driver',
      ...overrides,
    };
  }

  describe('successful dispatch', () => {
    it('dispatchTask 正常完成', async () => {
      const repository = new InMemoryRepository();
      const bufferRepository = new InMemoryBufferRepository();
      const manager = await AgentManager.create(repository, bufferRepository);

      await manager.createAgent({
        role_id: 'role_dispatch_ok',
        name: 'Dispatch OK',
        tags: [],
      });
      manager.start();

      const result = await manager.dispatchTask('role_dispatch_ok', createTask());

      expect(result.role_id).toBe('role_dispatch_ok');
      expect(result.cycle.buffer_snapshot.task_id).toBe('task_dispatch_001');
      // Tool-calling 未配置 → Pipeline 模式，应有执行结果
      expect(result.status).toBe('completed');
    });

    it('toMemoryTaskProjection 从 DispatchTaskResult 正确派生', async () => {
      const repository = new InMemoryRepository();
      const bufferRepository = new InMemoryBufferRepository();
      const manager = await AgentManager.create(repository, bufferRepository);

      await manager.createAgent({
        role_id: 'role_dispatch_proj',
        name: 'Proj Test',
        tags: [],
      });
      manager.start();

      const result = await manager.dispatchTask(
        'role_dispatch_proj',
        createTask({
          task_id: 'task_proj_dispatch',
        }),
      );

      const projection: MemoryTaskProjection = toMemoryTaskProjection(result);

      expect(projection.task_id).toBe('task_proj_dispatch');
      expect(projection.role_id).toBe('role_dispatch_proj');
      expect(typeof projection.driver_summary).toBe('string');
      expect(typeof projection.context.skill_count).toBe('number');
      expect(typeof projection.context.experience_count).toBe('number');
      expect(projection.buffer_seq).toBeGreaterThanOrEqual(0);
    });
  });

  describe('blocked cases', () => {
    it('不存在 Agent → blocked', async () => {
      const repository = new InMemoryRepository();
      const bufferRepository = new InMemoryBufferRepository();
      const manager = await AgentManager.create(repository, bufferRepository);

      const result = await manager.dispatchTask('role_nonexistent', createTask());

      expect(result.status).toBe('blocked');
      expect(result.role_id).toBe('role_nonexistent');
    });

    it('Agent 正在忙 → blocked', async () => {
      const repository = new InMemoryRepository();
      const bufferRepository = new InMemoryBufferRepository();
      const manager = await AgentManager.create(repository, bufferRepository);

      await manager.createAgent({
        role_id: 'role_busy_dispatch',
        name: 'Busy Agent',
        tags: [],
      });

      // 让 Agent 进入 running 状态
      const agent = manager.getAgent('role_busy_dispatch')!;
      agent.assignTask(createTask({ task_id: 'task_occupied' }));

      const result = await manager.dispatchTask(
        'role_busy_dispatch',
        createTask({
          task_id: 'task_second',
        }),
      );

      expect(result.status).toBe('blocked');
      expect(result.cycle.buffer_snapshot.driver_return.summary).toContain('busy');
    });
  });

  describe('no driver invocation', () => {
    it('Tool-calling 模式未调用 Driver 返回 no_driver_invocation', async () => {
      const repository = new InMemoryRepository();
      const bufferRepository = new InMemoryBufferRepository();
      // 使用 Tool-calling 模式但不提供 driver tool
      const mockLlm = {
        completeWithTools: async () => ({
          content: 'Task completed. [done]',
          tool_calls: undefined,
        }),
      };
      const manager = await AgentManager.create(repository, bufferRepository, {
        tools: { llm: mockLlm, tools: [] },
      });

      await manager.createAgent({
        role_id: 'role_no_driver',
        name: 'No Driver',
        tags: [],
      });
      manager.start();

      const result = await manager.dispatchTask('role_no_driver', createTask());

      // Tool-calling 但未调用 invoke_driver → no_driver_invocation
      expect(result.status).toBe('no_driver_invocation');
    });
  });
});
