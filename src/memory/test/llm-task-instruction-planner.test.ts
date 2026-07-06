import { describe, it, expect } from 'vitest';
import { LlmTaskInstructionPlanner } from '../adapters/llm-task-instruction-planner';
import { MockLlmClient } from '../adapters/mock-llm-client';
import type { AgentTaskRequest } from '../agent-types';

describe('LlmTaskInstructionPlanner', () => {
  it('正常流程：LLM 返回有效指令 → 返回 trimmed 结果', async () => {
    const llm = new MockLlmClient([
      { response: 'Refactor UserService to use dependency injection.' },
    ]);
    const planner = new LlmTaskInstructionPlanner(llm);

    const task: AgentTaskRequest = {
      spec: 'Refactor the UserService class to remove hardcoded dependencies',
      task_id: 'task_001',
    };

    const result = await planner.plan(task);

    expect(result).toBe('Refactor UserService to use dependency injection.');
  });

  it('LLM 抛异常 → 降级返回 spec 原文', async () => {
    const llm = new MockLlmClient([{ response: 'ERROR:Network timeout' }]);
    const planner = new LlmTaskInstructionPlanner(llm);

    const task: AgentTaskRequest = {
      spec: 'Fix login bug',
      task_id: 'task_002',
    };

    const result = await planner.plan(task);

    expect(result).toBe('Fix login bug');
  });

  it('LLM 返回空字符串 → 降级返回 spec 原文', async () => {
    const llm = new MockLlmClient([{ response: '   ' }]);
    const planner = new LlmTaskInstructionPlanner(llm);

    const task: AgentTaskRequest = {
      spec: 'Add pagination to list endpoint',
    };

    const result = await planner.plan(task);

    expect(result).toBe('Add pagination to list endpoint');
  });

  it('prompt 中包含 task.spec 内容', async () => {
    let capturedUserMessage = '';
    const capturingLlm = {
      async complete(input: { messages: Array<{ role: string; content: string }> }) {
        capturedUserMessage = input.messages.find((m) => m.role === 'user')?.content ?? '';
        return 'Test instruction';
      },
    };

    const planner = new LlmTaskInstructionPlanner(capturingLlm);

    await planner.plan({ spec: 'Fix authentication flow' });

    expect(capturedUserMessage).toContain('Fix authentication flow');
  });
});
