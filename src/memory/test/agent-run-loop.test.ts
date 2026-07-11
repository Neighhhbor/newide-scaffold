/**
 * Agent 持久循环（runLoopTick）测试
 *
 * 验证：
 *   1. assignTask 正确初始化状态
 *   2. runLoopTick idle（无任务）
 *   3. runLoopTick skipped（Pipeline 模式）
 *   4. runLoopTick running（单步执行）
 *   5. runLoopTick 多步积累 messages
 *   6. runLoopTick completed（LLM 报告完成）
 *   7. runLoopTick 最大轮次保护
 *   8. runOnce 向后兼容
 *   9. hasPendingTask 状态报告
 *   10. AgentManager.tickAll 驱动所有 running agent
 *   11. AgentManager.dispatchTask 异步派单
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import { Agent } from '../runtime/agent';
import type { AgentToolConfig } from '../runtime/agent';
import type { ToolCallResult, ToolCallingClient } from '../runtime/tool';
import type { Tool } from '../runtime/tool';
import { InMemoryRepository } from '../adapters/in-memory-repository';
import { InMemoryBufferRepository } from '../adapters/in-memory-buffer-repository';
import { createAgentMemoryScope } from '../adapters/agent-memory-scope';
import type { AgentTaskRequest } from '../agent-types';

// ──────────────────────────────────────────────
// Mock ToolCallingClient
// ──────────────────────────────────────────────

function createMockToolClient(responses: ToolCallResult[]): ToolCallingClient {
  let callIndex = 0;
  return {
    completeWithTools: async () => {
      const response = responses[callIndex];
      if (response === undefined) {
        throw new Error(`Unexpected call #${callIndex} - no more mock responses`);
      }
      callIndex++;
      return response;
    },
  };
}

/** 简易文本回复的 mock */
function textResponse(content: string): ToolCallResult {
  return { content, tool_calls: undefined };
}

// ──────────────────────────────────────────────
// 共享测试基础设施
// ──────────────────────────────────────────────

async function createTestInfra(role_id = 'role_loop_test') {
  const repository = new InMemoryRepository();
  const bufferRepository = new InMemoryBufferRepository();
  await repository.initializeAgent({ role_id, name: 'Test Agent', tags: [] });
  await bufferRepository.ensureAgent(role_id);
  const memory = createAgentMemoryScope(repository, bufferRepository, role_id);
  return { repository, bufferRepository, memory, role_id };
}

function createTestTask(overrides: Partial<AgentTaskRequest> = {}): AgentTaskRequest {
  return {
    spec: 'Test task specification.',
    task_id: 'task_loop_001',
    call_id: 'call_loop_001',
    source_driver: 'test-driver',
    ...overrides,
  };
}

function createToolConfig(mockLlm: ToolCallingClient, tools?: Tool[]): AgentToolConfig {
  return {
    llm: mockLlm,
    tools: tools ?? [],
    maxToolCalls: 20,
  };
}

// ──────────────────────────────────────────────
// Agent 持久循环
// ──────────────────────────────────────────────

describe('Agent persistent loop (runLoopTick)', () => {
  describe('assignTask', () => {
    it('为 Tool-calling Agent 正确初始化状态', async () => {
      const { memory } = await createTestInfra('role_assign');
      const agent = new Agent(memory, createToolConfig(createMockToolClient([])));

      expect(agent.hasPendingTask()).toBe(false);

      const task = createTestTask();
      (agent as any).assignTask(task);

      expect(agent.hasPendingTask()).toBe(true);
      expect(agent.getState()).toBe('running');
    });

    it('已有任务时 assignTask 抛出错误', async () => {
      const { memory } = await createTestInfra('role_assign_conflict');
      const agent = new Agent(memory, createToolConfig(createMockToolClient([])));

      (agent as any).assignTask(createTestTask());
      await expect(
        (agent as any).assignTask(createTestTask({ task_id: 'task_002' })),
      ).rejects.toThrow('already has a running task');
    });

    it('clearLoopState 后清除所有持久状态', async () => {
      const { memory } = await createTestInfra('role_stop_clear');
      const agent = new Agent(memory, createToolConfig(createMockToolClient([])));

      (agent as any).assignTask(createTestTask());
      expect(agent.hasPendingTask()).toBe(true);

      (agent as any).clearLoopState();
      (agent as any).state = 'stopped';
      expect(agent.hasPendingTask()).toBe(false);
      expect(agent.getState()).toBe('stopped');
    });
  });

  describe('runLoopTick running（单步执行）', () => {
    it('LLM 回复文本后返回 running', async () => {
      const { memory } = await createTestInfra('role_one_step');
      const mockLlm = createMockToolClient([
        textResponse('Let me think about this...'),
        textResponse('Task completed. All done.'),
      ]);
      const agent = new Agent(memory, createToolConfig(mockLlm));

      await (agent as any).assignTask(createTestTask());

      const result = await (agent as any).runLoopTick();
      expect(result.status).toBe('running');
      expect(result.reason).toContain('Round 1 completed');
      expect(agent.getState()).toBe('running');
    });

    it('多步积累 messages 保持 running', async () => {
      const { memory } = await createTestInfra('role_multi_step');
      const mockLlm = createMockToolClient([
        textResponse('Step 1: analyzing...'),
        textResponse('Step 2: processing...'),
        textResponse('Step 3: almost done...'),
        textResponse('Task completed.'),
      ]);
      const agent = new Agent(memory, createToolConfig(mockLlm));

      await (agent as any).assignTask(createTestTask());

      // Tick 1
      const r1 = await (agent as any).runLoopTick();
      expect(r1.status).toBe('running');
      expect(agent.getState()).toBe('running');

      // Tick 2
      const r2 = await (agent as any).runLoopTick();
      expect(r2.status).toBe('running');

      // Tick 3
      const r3 = await (agent as any).runLoopTick();
      expect(r3.status).toBe('running');

      // Tick 4 — 完成
      const r4 = await (agent as any).runLoopTick();
      expect(r4.status).toBe('completed');
      expect(agent.getState()).toBe('sleeping');
      expect(agent.hasPendingTask()).toBe(false);
    });

    it('tool_call 执行后返回 running', async () => {
      const { memory } = await createTestInfra('role_tool_step');
      let toolExecuted = false;
      const mockTool: Tool = {
        name: 'test_tool',
        description: 'A test tool',
        inputSchema: { type: 'object', properties: {} },
        execute: async () => {
          toolExecuted = true;
          return { result: 'tool output' };
        },
      };
      const mockLlm = createMockToolClient([
        {
          content: null,
          tool_calls: [
            {
              id: 'call_tool',
              type: 'function',
              function: { name: 'test_tool', arguments: '{}' },
            },
          ],
        },
        textResponse('Task completed. [done]'),
      ]);
      const agent = new Agent(memory, createToolConfig(mockLlm, [mockTool]));

      await (agent as any).assignTask(createTestTask());

      // Tick 1: 调用工具
      const r1 = await (agent as any).runLoopTick();
      expect(r1.status).toBe('running');
      expect(toolExecuted).toBe(true);

      // Tick 2: 完成
      const r2 = await (agent as any).runLoopTick();
      expect(r2.status).toBe('completed');
    });

    it('未知工具不中断循环', async () => {
      const { memory } = await createTestInfra('role_unknown_tool');
      const mockLlm = createMockToolClient([
        {
          content: null,
          tool_calls: [
            {
              id: 'call_unknown',
              type: 'function',
              function: { name: 'nonexistent', arguments: '{}' },
            },
          ],
        },
        textResponse('Task completed.'),
      ]);
      const agent = new Agent(memory, createToolConfig(mockLlm));

      await (agent as any).assignTask(createTestTask());

      // Tick 1: 未知工具→报错但不抛异常
      const r1 = await (agent as any).runLoopTick();
      expect(r1.status).toBe('running');

      // Tick 2: 完成
      const r2 = await (agent as any).runLoopTick();
      expect(r2.status).toBe('completed');
    });
  });

  describe('runLoopTick completed', () => {
    it('LLM 报告完成时状态变为 sleeping', async () => {
      const { memory } = await createTestInfra('role_complete');
      const mockLlm = createMockToolClient([textResponse('Task completed. All done.')]);
      const agent = new Agent(memory, createToolConfig(mockLlm));

      await (agent as any).assignTask(createTestTask());

      const result = await (agent as any).runLoopTick();
      expect(result.status).toBe('completed');
      expect(agent.getState()).toBe('sleeping');
      expect(agent.hasPendingTask()).toBe(false);
    });

    it('完成时写入 buffer', async () => {
      const { memory, bufferRepository } = await createTestInfra('role_buffer');
      const mockLlm = createMockToolClient([textResponse('Task completed. [done]')]);
      const agent = new Agent(memory, createToolConfig(mockLlm));

      // 预先验证 buffer 为空
      const metaBefore = await bufferRepository.getBufferMeta('role_buffer');
      expect(metaBefore.total_processed).toBe(0);

      await (agent as any).assignTask(createTestTask());
      await (agent as any).runLoopTick();

      // buffer 应有记录（pending 状态，提取已解耦不被同步标记为 processed）
      const metaAfter = await bufferRepository.getBufferMeta('role_buffer');
      expect(metaAfter.pending_count).toBe(1);
    });
  });

  describe('runLoopTick 最大轮次保护', () => {
    it('达到 maxToolCalls 时强制完成', async () => {
      const { memory } = await createTestInfra('role_maxrounds');
      // 一直返回文本，不报告完成
      const mockLlm = createMockToolClient(
        Array.from({ length: 5 }, () => textResponse('Still thinking...')),
      );
      const config: AgentToolConfig = {
        llm: mockLlm,
        tools: [],
        maxToolCalls: 3,
      };
      const agent = new Agent(memory, config);

      await (agent as any).assignTask(createTestTask());

      // Round 1-3: running (loopRound: 0→1→2→3, each < maxToolCalls)
      expect((await (agent as any).runLoopTick()).status).toBe('running');
      expect((await (agent as any).runLoopTick()).status).toBe('running');
      expect((await (agent as any).runLoopTick()).status).toBe('running');

      // Round 4: loopRound (3) >= maxToolCalls (3) → completed
      const r4 = await (agent as any).runLoopTick();
      expect(r4.status).toBe('completed');
      expect(r4.reason).toContain('Max tool calls');
      expect(agent.getState()).toBe('sleeping');
    });
  });
});

// ──────────────────────────────────────────────
// runOnce 向后兼容
// ──────────────────────────────────────────────

describe('runOnce backward compatibility', () => {
  it('Tool-calling 模式 runOnce 仍能同步执行', async () => {
    const { memory } = await createTestInfra('role_compat_tc');
    const mockLlm = createMockToolClient([textResponse('Task completed. [done]')]);
    const agent = new Agent(memory, createToolConfig(mockLlm));

    const result = await agent.runOnce(createTestTask());
    expect(result.agent_id).toBe('role_compat_tc');
    expect(result.buffer_snapshot.task_id).toBe('task_loop_001');
  });

  it('Tool-calling 模式 runOnce 多轮交互正常', async () => {
    const { memory } = await createTestInfra('role_compat_multi');
    const mockLlm = createMockToolClient([
      textResponse('Let me think...'),
      textResponse('Working on it...'),
      textResponse('Task finished.'),
    ]);
    const agent = new Agent(memory, createToolConfig(mockLlm));

    const result = await agent.runOnce(createTestTask());
    expect(result.agent_id).toBe('role_compat_multi');
  });
});

// ──────────────────────────────────────────────
// AgentManager dispatchTask
// ──────────────────────────────────────────────

describe('AgentManager dispatchTask', () => {
  it('dispatchTask 同步执行完成（内部循环逐 tick 直至完成）', async () => {
    const { AgentManager } = await import('../runtime/agent-manager');
    const repository = new InMemoryRepository();
    const bufferRepository = new InMemoryBufferRepository();

    const mockLlm = createMockToolClient([
      textResponse('Processing...'),
      textResponse('Task complete. [done]'),
    ]);

    const manager = await AgentManager.create(repository, bufferRepository, {
      tools: { llm: mockLlm, tools: [] },
    });

    await manager.createAgent({ role_id: 'role_async_task', name: 'Async Agent', tags: [] });

    // dispatchTask 同步执行完成（内部循环逐 tick 直至完成）
    const result = await manager.dispatchTask(
      'role_async_task',
      createTestTask({ task_id: 'task_async' }),
    );
    expect(result.status).toBe('no_driver_invocation');
    expect(result.role_id).toBe('role_async_task');
    expect(result.cycle).toBeDefined();
    expect(result.cycle.buffer_snapshot.task_id).toBe('task_async');

    // agent 已回到 sleeping
    const agent = manager.getAgent('role_async_task')!;
    expect(agent.getState()).toBe('sleeping');

    // 验证 buffer 已写入（pending 状态，提取由离线 Processor 处理）
    const meta = await bufferRepository.getBufferMeta('role_async_task');
    expect(meta.pending_count).toBe(1);
  });
});
