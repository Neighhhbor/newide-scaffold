import { describe, it, expect } from 'vitest';
import { LlmContextCleaner } from '../adapters/context-cleaner';
import { MockLlmClient } from '../adapters/mock-llm-client';
import type { AgentContextCleanInput } from '../ports/agent-context-cleaner';
import type { DriverReturn } from '../schemas';

const emptyDriverReturn: DriverReturn = {
  artifacts: [],
  summary: '',
  decisions: [],
  blockers: [],
  referenced_experiences: [],
  assumptions: [],
};

function makeInput(overrides: Partial<AgentContextCleanInput> = {}): AgentContextCleanInput {
  return {
    agent_id: 'agent_001',
    source_task_id: 'task_001',
    raw_context:
      'Agent thought about using JWT for authentication. Decided to implement refresh token flow.',
    driver_returns: [
      {
        call_id: 'call_001',
        driver_id: 'mock-driver',
        driver_return: {
          ...emptyDriverReturn,
          summary: 'Implemented JWT refresh token flow',
          decisions: [
            {
              point: 'Auth method',
              options: ['JWT', 'sessions'],
              chosen: 'JWT',
              reason: 'more scalable',
            },
          ],
        },
      },
    ],
    ...overrides,
  };
}

describe('LlmContextCleaner', () => {
  it('正常流程：LLM 返回有效 JSON → 返回完整 snapshot', async () => {
    const llm = new MockLlmClient([
      {
        response: JSON.stringify({
          thinking_trace: 'Considered JWT vs sessions, chose JWT for scalability',
          planning_trace:
            '1. Implement token generation, 2. Add refresh endpoint, 3. Add validation middleware',
        }),
      },
    ]);
    const cleaner = new LlmContextCleaner(llm);

    const result = await cleaner.clean(makeInput());

    expect(result).not.toBeNull();
    expect(result!.agent_id).toBe('agent_001');
    expect(result!.source_task_id).toBe('task_001');
    expect(result!.thinking_trace).toContain('JWT');
    expect(result!.planning_trace).toContain('refresh endpoint');
    expect(result!.snapshot_id).toBeDefined();
    expect(result!.cleaned_at).toBeDefined();
  });

  it('返回的 snapshot 包含正确的 driver_calls', async () => {
    const llm = new MockLlmClient([
      {
        response: JSON.stringify({
          thinking_trace: 'Debugged database connection issue',
          planning_trace: '1. Check connection pool, 2. Add retry logic',
        }),
      },
    ]);
    const cleaner = new LlmContextCleaner(llm);

    const result = await cleaner.clean(
      makeInput({
        driver_returns: [
          {
            call_id: 'call_001',
            driver_id: 'db-driver',
            driver_return: { ...emptyDriverReturn, summary: 'Fixed connection pool' },
          },
          {
            call_id: 'call_002',
            driver_id: 'cache-driver',
            driver_return: { ...emptyDriverReturn, summary: 'Cleared cache' },
          },
        ],
      }),
    );

    expect(result).not.toBeNull();
    expect(result!.driver_calls).toHaveLength(2);
    expect(result!.driver_calls[0]!.call_id).toBe('call_001');
    expect(result!.driver_calls[0]!.driver_id).toBe('db-driver');
    expect(result!.driver_calls[1]!.call_id).toBe('call_002');
    expect(result!.driver_calls[1]!.driver_id).toBe('cache-driver');
  });

  it('返回的 snapshot 包含 token 估算和压缩比', async () => {
    const llm = new MockLlmClient([
      {
        response: JSON.stringify({
          thinking_trace: 'Short thinking',
          planning_trace: 'Short plan',
        }),
      },
    ]);
    const cleaner = new LlmContextCleaner(llm);

    const input = makeInput({ raw_context: 'A very long raw context '.repeat(100) });
    const result = await cleaner.clean(input);

    expect(result).not.toBeNull();
    expect(result!.original_token_count).toBeGreaterThan(0);
    expect(result!.cleaned_token_count).toBeGreaterThan(0);
    expect(result!.compression_ratio).toBeGreaterThan(0);
    expect(result!.compression_ratio).toBeLessThan(1);
  });

  it('JSON 格式错误 → 返回 null（降级）', async () => {
    const llm = new MockLlmClient([{ response: 'not valid json' }]);
    const cleaner = new LlmContextCleaner(llm);

    const result = await cleaner.clean(makeInput());

    expect(result).toBeNull();
  });

  it('LLM 抛异常 → 返回 null（降级）', async () => {
    const llm = new MockLlmClient([{ response: 'ERROR:Network timeout' }]);
    const cleaner = new LlmContextCleaner(llm);

    const result = await cleaner.clean(makeInput());

    expect(result).toBeNull();
  });

  it('缺少 thinking_trace 字段 → 返回 null', async () => {
    const llm = new MockLlmClient([
      {
        response: JSON.stringify({ planning_trace: 'Only plan' }),
      },
    ]);
    const cleaner = new LlmContextCleaner(llm);

    const result = await cleaner.clean(makeInput());

    expect(result).toBeNull();
  });

  it('空 driver_returns → snapshot 中 driver_calls 为空数组', async () => {
    const llm = new MockLlmClient([
      {
        response: JSON.stringify({
          thinking_trace: 'No drivers called',
          planning_trace: 'Direct execution',
        }),
      },
    ]);
    const cleaner = new LlmContextCleaner(llm);

    const result = await cleaner.clean(makeInput({ driver_returns: [] }));

    expect(result).not.toBeNull();
    expect(result!.driver_calls).toHaveLength(0);
  });
});
