/**
 * Agent tool-calling 模式测试
 *
 * 验证：
 *   1. Agent 不传 toolConfig → 走 pipeline 模式（向后兼容）
 *   2. Agent 传 toolConfig → 走 tool-calling 模式
 *   3. Tool-calling 循环正确处理 tool_call 和文本回复
 *   4. 后处理流程（buffer → extract → promote）正常
 */
import { describe, it, expect } from 'vitest';
import { Agent } from '../runtime/agent';
import type { AgentToolConfig } from '../runtime/agent';
import type { ToolCallResult, ToolCallingClient } from '../runtime/tool';
import { InMemoryRepository } from '../adapters/in-memory-repository';
import { InMemoryBufferRepository } from '../adapters/in-memory-buffer-repository';
import { createAgentMemoryScope } from '../adapters/agent-memory-scope';
import type { DriverReturn } from '../schemas';
import { InvokeDriverTool } from '../runtime/tools/invoke-driver-tool';

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

// ──────────────────────────────────────────────
// 共享存储
// ──────────────────────────────────────────────

function createTestInfra(role_id = 'role_test') {
  const repository = new InMemoryRepository();
  const bufferRepository = new InMemoryBufferRepository();
  return { repository, bufferRepository, role_id };
}

async function createTestAgent(
  role_id: string,
  repository: InMemoryRepository,
  bufferRepository: InMemoryBufferRepository,
  toolConfig?: AgentToolConfig,
) {
  await repository.initializeAgent({ role_id, name: 'Test Agent', tags: [] });
  await bufferRepository.ensureAgent(role_id);
  const memory = createAgentMemoryScope(repository, bufferRepository, role_id);
  return new Agent(memory, undefined, toolConfig);
}

describe('Agent tool-calling mode', () => {
  it('不传 toolConfig → runOnce 走 pipeline 模式（向后兼容）', async () => {
    const { repository, bufferRepository, role_id } = createTestInfra('role_compat');
    const agent = await createTestAgent(role_id, repository, bufferRepository);

    const result = await agent.runOnce({
      spec: 'Test backward compatibility.',
      task_id: 'task_compat_001',
      call_id: 'call_compat_001',
      source_driver: 'mock-driver',
    });

    expect(result.agent_id).toBe(role_id);
    expect(result.buffer_snapshot.task_id).toBe('task_compat_001');
    expect(result.extraction.experiences).toBeDefined();
  });

  it('传 toolConfig → runOnce 走 tool-calling 模式（LLM 返回文本直接完成）', async () => {
    const { repository, bufferRepository, role_id } = createTestInfra('role_tc_text');
    const mockLlm = createMockToolClient([
      { content: 'Task completed. All done.', tool_calls: undefined },
    ]);

    const agent = await createTestAgent(role_id, repository, bufferRepository, {
      llm: mockLlm,
      tools: [],
    });

    const result = await agent.runOnce({
      spec: 'A simple task.',
      task_id: 'task_tc_text_001',
      call_id: 'call_tc_text_001',
      source_driver: 'tool-agent',
    });

    expect(result.agent_id).toBe(role_id);
    expect(result.buffer_snapshot.task_id).toBe('task_tc_text_001');
    // 后处理应当正常执行（提取经验）
    expect(result.extraction.experiences).toBeDefined();
  });

  it('tool-calling 循环：LLM 调用 invoke_driver → 执行 → 返回结果', async () => {
    const { repository, bufferRepository, role_id } = createTestInfra('role_tc_driver');

    // 记录 driver 调用
    let driverCalled = false;
    let lastInstruction = '';

    const driverTool = new InvokeDriverTool(async (task) => {
      driverCalled = true;
      lastInstruction = task.instruction;
      const result: DriverReturn = {
        summary: `Executed: ${task.instruction}`,
        artifacts: [{ type: 'text', path: 'output.txt', summary: 'test output' }],
        decisions: [],
        blockers: [],
        referenced_experiences: [],
        assumptions: [],
      };
      return result;
    });

    const mockLlm = createMockToolClient([
      // 第一轮：调用 invoke_driver
      {
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'invoke_driver', arguments: '{"instruction": "Build the feature"}' },
          },
        ],
      },
      // 第二轮：任务完成
      { content: 'Task completed. [done]', tool_calls: undefined },
    ]);

    const agent = await createTestAgent(role_id, repository, bufferRepository, {
      llm: mockLlm,
      tools: [driverTool],
    });

    const result = await agent.runOnce({
      spec: 'Implement feature X.',
      task_id: 'task_tc_driver_001',
      call_id: 'call_tc_driver_001',
      source_driver: 'tool-agent',
    });

    // 验证 driver 被调用
    expect(driverCalled).toBe(true);
    expect(lastInstruction).toBe('Build the feature');

    // 验证结果
    expect(result.agent_id).toBe(role_id);
    expect(result.buffer_snapshot.driver_return.summary).toBe('Executed: Build the feature');
    expect(result.extraction.experiences).toBeDefined();
  });

  it('tool-calling 循环：LLM 调用未知工具 → 报错但不中断循环', async () => {
    const { repository, bufferRepository, role_id } = createTestInfra('role_tc_unknown');

    const mockLlm = createMockToolClient([
      // 调用一个不存在的工具
      {
        content: null,
        tool_calls: [
          {
            id: 'call_unknown',
            type: 'function',
            function: { name: 'nonexistent_tool', arguments: '{}' },
          },
        ],
      },
      // 然后完成
      { content: 'Task completed.', tool_calls: undefined },
    ]);

    const agent = await createTestAgent(role_id, repository, bufferRepository, {
      llm: mockLlm,
      tools: [],
    });

    // 不应抛异常
    const result = await agent.runOnce({
      spec: 'Test unknown tool handling.',
      task_id: 'task_tc_unknown_001',
      call_id: 'call_tc_unknown_001',
      source_driver: 'tool-agent',
    });

    expect(result.agent_id).toBe(role_id);
  });

  it('tool-calling 循环：多个 tool_call 在单轮中执行', async () => {
    const { repository, bufferRepository, role_id } = createTestInfra('role_tc_multi');

    let driverCallCount = 0;

    const driverTool = new InvokeDriverTool(async (task) => {
      driverCallCount++;
      return {
        summary: `Driver ${driverCallCount}: ${task.instruction}`,
        artifacts: [],
        decisions: [],
        blockers: [],
        referenced_experiences: [],
        assumptions: [],
      };
    });

    const mockLlm = createMockToolClient([
      // 第一轮：同时调用两个 driver
      {
        content: null,
        tool_calls: [
          {
            id: 'call_a',
            type: 'function',
            function: { name: 'invoke_driver', arguments: '{"instruction": "Task A"}' },
          },
          {
            id: 'call_b',
            type: 'function',
            function: { name: 'invoke_driver', arguments: '{"instruction": "Task B"}' },
          },
        ],
      },
      // 第二轮：完成
      { content: 'All done.', tool_calls: undefined },
    ]);

    const agent = await createTestAgent(role_id, repository, bufferRepository, {
      llm: mockLlm,
      tools: [driverTool],
    });

    const result = await agent.runOnce({
      spec: 'Execute multiple sub-tasks.',
      task_id: 'task_tc_multi_001',
      call_id: 'call_tc_multi_001',
      source_driver: 'tool-agent',
    });

    // 两个 driver 都调用了
    expect(driverCallCount).toBe(2);
    // 最终结果使用最后一次 driver 调用
    expect(result.buffer_snapshot.driver_return.summary).toContain('Driver 2');
  });

  it('通过 AgentManager 传入 toolConfig 创建 tool-calling agent', async () => {
    const { repository, bufferRepository, role_id } = createTestInfra('role_mgr_tc');
    const { AgentManager } = await import('../runtime/agent-manager');

    const mockLlm = createMockToolClient([
      { content: 'Task finished. [done]', tool_calls: undefined },
    ]);

    const manager = AgentManager.create(repository, bufferRepository, {
      tools: { llm: mockLlm, tools: [] },
    });

    const handle = await manager.createAgent({ role_id, name: 'Manager Tool Agent', tags: [] });
    expect(handle.role_id).toBe(role_id);

    const result = await manager.submitTask({
      spec: 'Test manager tool-calling.',
      task_id: 'task_mgr_tc_001',
      call_id: 'call_mgr_tc_001',
      source_driver: 'tool-agent',
    });

    expect(result.winner_role_id).toBe(role_id);
    expect(result.cycle.buffer_snapshot.task_id).toBe('task_mgr_tc_001');
  });
});
