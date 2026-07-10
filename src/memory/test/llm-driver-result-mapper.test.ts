/**
 * LlmDriverResultMapper 单元测试
 *
 * 覆盖两条路径：
 * 1. LLM 正常返回 → 解析为 5 字段 + 确定性 referenced_experiences
 * 2. LLM 失败/格式异常 → 降级到 mapRunResultToDriverReturn（启发式映射器）
 */
import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, createId } from '../../core';
import type { DriverRunResult } from '../../driver';
import { MockLlmClient } from '../adapters/mock-llm-client';
import { LlmDriverResultMapper } from '../adapters/llm-driver-result-mapper';
import type { DriverInvokeInput } from '../runtime/agent-run-deps';
import type { DriverContext } from '../types';
import type { ExperienceRecord } from '../schemas';

// ═══════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════

function makeDriverContext(overrides: Partial<DriverContext> = {}): DriverContext {
  return {
    task_instruction: 'Fix SQL injection in auth module.',
    skills: [],
    experiences: [],
    ...overrides,
  };
}

function makeInvokeInput(overrides: Partial<DriverInvokeInput> = {}): DriverInvokeInput {
  return {
    task_id: 'task_test',
    call_id: 'call_test',
    source_driver: 'test-driver',
    driver_context: makeDriverContext(),
    ...overrides,
  };
}

function makeExperience(overrides: Partial<ExperienceRecord> = {}): ExperienceRecord {
  return {
    id: 'exp-1',
    description: 'Test experience',
    description_embedding: [],
    content: 'Test content.',
    confidence: 0.9,
    tags: ['test'],
    agent_id: 'agent_a',
    type: 'positive',
    confidence_history: [],
    referenced_count: 0,
    source_task_id: 'task_001',
    source_driver: 'test-driver',
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeDriverRunResult(overrides: Partial<DriverRunResult> = {}): DriverRunResult {
  const created_at = '2026-07-09T00:00:01.000Z';
  return {
    driver_run_result_id: 'driver_result_test',
    session_id: 'session_test',
    status: 'succeeded',
    artifacts: [
      {
        artifact_id: createId('artifact'),
        type: 'patch',
        uri: 'artifact://patch/task_test/fix.patch',
        producer_id: 'test-driver',
        task_id: 'task_test',
        created_at,
        schema_version: SCHEMA_VERSION,
      },
    ],
    transcript_ref: {
      artifact_id: createId('artifact'),
      type: 'transcript',
      uri: 'artifact://transcript/task_test/session',
      producer_id: 'test-driver',
      task_id: 'task_test',
      created_at,
      schema_version: SCHEMA_VERSION,
    },
    tool_events: [],
    diagnostics: {
      driver_id: 'test-driver',
      duration_ms: 10,
      notes: ['Test driver completed.'],
    },
    created_at,
    schema_version: SCHEMA_VERSION,
    ...overrides,
  };
}

/** 构造一个合法的 LLM JSON 响应 */
function makeValidLlmResponse(overrides: Partial<Record<string, unknown>> = {}): string {
  const response = {
    artifacts: [{ type: 'patch', path: '/fix.patch', summary: 'Fixed SQL injection' }],
    summary:
      'The Driver identified and fixed a SQL injection vulnerability by replacing string concatenation with parameterized queries.',
    decisions: [
      {
        point: 'Fix strategy for SQL injection',
        options: ['parameterized queries', 'input escaping', 'ORM migration'],
        chosen: 'parameterized queries',
        reason: 'Most secure approach with minimal code changes',
      },
    ],
    blockers: [],
    assumptions: [
      {
        assumption: 'Database supports parameterized queries',
        risk_if_wrong: 'Fix would need to use alternative approach like input escaping',
      },
    ],
    ...overrides,
  };
  return JSON.stringify(response);
}

// ═══════════════════════════════════════════
// §1 LLM 正常路径
// ═══════════════════════════════════════════

describe('LlmDriverResultMapper — LLM success path', () => {
  it('extracts all 5 LLM fields from DriverRunResult', async () => {
    const mockLlm = new MockLlmClient([{ response: makeValidLlmResponse() }]);

    const mapper = new LlmDriverResultMapper(mockLlm);
    const result = makeDriverRunResult({
      tool_events: [
        {
          tool_event_id: createId('tool_event'),
          tool_name: 'write_file',
          status: 'completed',
          summary: 'Wrote auth/login.ts with fix',
          created_at: '2026-07-09T00:00:01.000Z',
          schema_version: SCHEMA_VERSION,
        },
      ],
      diagnostics: {
        driver_id: 'test-driver',
        duration_ms: 100,
        notes: ['Applied parameterized query fix.', 'Ran 12 tests.'],
      },
    });
    const input = makeInvokeInput();

    const driverReturn = await mapper.map(result, input);

    expect(driverReturn.artifacts).toHaveLength(1);
    expect(driverReturn.artifacts[0]).toMatchObject({
      type: 'patch',
      path: '/fix.patch',
      summary: 'Fixed SQL injection',
    });
    expect(driverReturn.summary).toContain('SQL injection');
    expect(driverReturn.decisions).toHaveLength(1);
    expect(driverReturn.decisions[0]).toMatchObject({
      point: 'Fix strategy for SQL injection',
      chosen: 'parameterized queries',
    });
    expect(driverReturn.blockers).toEqual([]);
    expect(driverReturn.assumptions).toHaveLength(1);
    expect(driverReturn.assumptions[0]).toMatchObject({
      assumption: 'Database supports parameterized queries',
    });
  });

  it('builds referenced_experiences deterministically (no LLM involved)', async () => {
    const mockLlm = new MockLlmClient([{ response: makeValidLlmResponse() }]);

    const mapper = new LlmDriverResultMapper(mockLlm);
    const exp1 = makeExperience({ id: 'exp-ref-a', description: 'Ref A' });
    const exp2 = makeExperience({ id: 'exp-ref-b', description: 'Ref B' });
    const context = makeDriverContext({ experiences: [exp1, exp2] });
    const input = makeInvokeInput({ driver_context: context });
    const result = makeDriverRunResult();

    const driverReturn = await mapper.map(result, input);

    expect(driverReturn.referenced_experiences).toHaveLength(2);
    expect(driverReturn.referenced_experiences[0]).toMatchObject({
      experience_id: 'exp-ref-a',
      applied: true,
      effectiveness: 'not_applicable',
    });
    expect(driverReturn.referenced_experiences[0]!.note).toContain('Automatic mapping');
    expect(driverReturn.referenced_experiences[1]).toMatchObject({
      experience_id: 'exp-ref-b',
      applied: true,
      effectiveness: 'not_applicable',
    });
  });

  it('returns empty referenced_experiences when no experiences in context', async () => {
    const mockLlm = new MockLlmClient([{ response: makeValidLlmResponse() }]);

    const mapper = new LlmDriverResultMapper(mockLlm);
    const input = makeInvokeInput({ driver_context: makeDriverContext({ experiences: [] }) });
    const result = makeDriverRunResult();

    const driverReturn = await mapper.map(result, input);

    expect(driverReturn.referenced_experiences).toEqual([]);
  });

  it('handles multiple decisions from LLM', async () => {
    const mockLlm = new MockLlmClient([
      {
        response: makeValidLlmResponse({
          decisions: [
            {
              point: 'Choice A',
              options: ['opt1', 'opt2'],
              chosen: 'opt1',
              reason: 'Better performance',
            },
            {
              point: 'Choice B',
              options: ['opt3', 'opt4'],
              chosen: 'opt3',
              reason: 'Safer approach',
            },
          ],
        }),
      },
    ]);

    const mapper = new LlmDriverResultMapper(mockLlm);
    const result = makeDriverRunResult();
    const input = makeInvokeInput();

    const driverReturn = await mapper.map(result, input);

    expect(driverReturn.decisions).toHaveLength(2);
    expect(driverReturn.decisions[0]!.point).toBe('Choice A');
    expect(driverReturn.decisions[1]!.point).toBe('Choice B');
  });

  it('handles multiple blockers from LLM', async () => {
    const mockLlm = new MockLlmClient([
      {
        response: makeValidLlmResponse({
          blockers: [
            {
              blocker: 'npm install failed',
              attempts: ['retry with --force', 'clear cache'],
              resolution: 'Used --legacy-peer-deps flag',
              resolved: true,
            },
            {
              blocker: 'Type error in legacy code',
              attempts: ['add type assertion'],
              resolution: 'Not resolved — needs upstream fix',
              resolved: false,
            },
          ],
        }),
      },
    ]);

    const mapper = new LlmDriverResultMapper(mockLlm);
    const result = makeDriverRunResult();
    const input = makeInvokeInput();

    const driverReturn = await mapper.map(result, input);

    expect(driverReturn.blockers).toHaveLength(2);
    expect(driverReturn.blockers[0]).toMatchObject({
      blocker: 'npm install failed',
      resolved: true,
    });
    expect(driverReturn.blockers[1]).toMatchObject({
      blocker: 'Type error in legacy code',
      resolved: false,
    });
  });

  it('propagates task_instruction into prompt (verified via MockLlmClient match)', async () => {
    const mockLlm = new MockLlmClient([
      {
        match: /Deploy Kubernetes cluster/,
        response: makeValidLlmResponse({
          summary: 'Deployed K8s cluster with 3 nodes.',
        }),
      },
    ]);

    const mapper = new LlmDriverResultMapper(mockLlm);
    const input = makeInvokeInput({
      driver_context: makeDriverContext({
        task_instruction: 'Deploy Kubernetes cluster to production.',
      }),
    });
    const result = makeDriverRunResult();

    const driverReturn = await mapper.map(result, input);

    // MockLlmClient matched the task_instruction pattern → returned our custom response
    expect(driverReturn.summary).toBe('Deployed K8s cluster with 3 nodes.');
  });

  it('passes tool_events and diagnostics into prompt', async () => {
    const mockLlm = new MockLlmClient([
      {
        match: /lint_check.*completed/,
        response: makeValidLlmResponse({
          summary: 'Linting completed successfully.',
        }),
      },
    ]);

    const mapper = new LlmDriverResultMapper(mockLlm);
    const result = makeDriverRunResult({
      tool_events: [
        {
          tool_event_id: createId('tool_event'),
          tool_name: 'lint_check',
          status: 'completed',
          summary: 'No lint errors found',
          created_at: '2026-07-09T00:00:01.000Z',
          schema_version: SCHEMA_VERSION,
        },
      ],
    });
    const input = makeInvokeInput();

    const driverReturn = await mapper.map(result, input);

    expect(driverReturn.summary).toBe('Linting completed successfully.');
  });

  it('includes error details in prompt', async () => {
    const mockLlm = new MockLlmClient([
      {
        match: /TIMEOUT.*60s/,
        response: makeValidLlmResponse({
          summary: 'Task timed out after 60 seconds.',
          blockers: [
            {
              blocker: 'Execution timeout',
              attempts: ['Increased timeout to 120s'],
              resolution: 'Not resolved — task too large',
              resolved: false,
            },
          ],
        }),
      },
    ]);

    const mapper = new LlmDriverResultMapper(mockLlm);
    const result = makeDriverRunResult({
      status: 'failed',
      error: { code: 'TIMEOUT', message: 'Task exceeded 60s limit', retryable: true },
    });
    const input = makeInvokeInput();

    const driverReturn = await mapper.map(result, input);

    expect(driverReturn.summary).toBe('Task timed out after 60 seconds.');
    expect(driverReturn.blockers).toHaveLength(1);
    expect(driverReturn.blockers[0]!.blocker).toBe('Execution timeout');
  });

  it('returns complete 6-field DriverReturn structure', async () => {
    const mockLlm = new MockLlmClient([{ response: makeValidLlmResponse() }]);

    const mapper = new LlmDriverResultMapper(mockLlm);
    const result = makeDriverRunResult();
    const input = makeInvokeInput();

    const driverReturn = await mapper.map(result, input);

    expect(driverReturn).toHaveProperty('artifacts');
    expect(driverReturn).toHaveProperty('summary');
    expect(driverReturn).toHaveProperty('decisions');
    expect(driverReturn).toHaveProperty('blockers');
    expect(driverReturn).toHaveProperty('referenced_experiences');
    expect(driverReturn).toHaveProperty('assumptions');
  });
});

// ═══════════════════════════════════════════
// §2 LLM 失败 → 降级路径
// ═══════════════════════════════════════════

describe('LlmDriverResultMapper — fallback to heuristic mapper', () => {
  it('falls back when LLM returns malformed JSON', async () => {
    const mockLlm = new MockLlmClient([{ response: 'this is not json at all' }]);

    const mapper = new LlmDriverResultMapper(mockLlm);
    const result = makeDriverRunResult({
      tool_events: [
        {
          tool_event_id: createId('tool_event'),
          tool_name: 'write_file',
          status: 'completed',
          summary: 'Wrote fix',
          created_at: '2026-07-09T00:00:01.000Z',
          schema_version: SCHEMA_VERSION,
        },
      ],
      diagnostics: {
        driver_id: 'test-driver',
        duration_ms: 42,
        notes: ['Applied fix.'],
      },
    });
    const input = makeInvokeInput({
      driver_context: makeDriverContext({
        task_instruction: '假设：目标数据库为MySQL 8.0。',
      }),
    });

    const driverReturn = await mapper.map(result, input);

    // 降级到启发式映射器：decisions 从 tool_events 推断
    expect(driverReturn.decisions.length).toBeGreaterThan(0);
    expect(driverReturn.decisions[0]!.point).toContain('write_file');
    // summary 含 diagnostics 信息
    expect(driverReturn.summary).toContain('Applied fix.');
    // assumptions 从 task_instruction 正则提取
    const mysqlAssumption = driverReturn.assumptions.find(
      (a) => a.assumption === '目标数据库为MySQL 8.0',
    );
    expect(mysqlAssumption).toBeDefined();
    // referenced_experiences 确定性构建
    expect(driverReturn.referenced_experiences).toEqual([]);
  });

  it('falls back when LLM response is empty', async () => {
    const mockLlm = new MockLlmClient([{ response: '' }]);

    const mapper = new LlmDriverResultMapper(mockLlm);
    const result = makeDriverRunResult();
    const input = makeInvokeInput();

    const driverReturn = await mapper.map(result, input);

    // 降级成功：6 字段完整
    expect(driverReturn.artifacts).toBeDefined();
    expect(driverReturn.summary).toBeDefined();
    expect(driverReturn.decisions).toBeDefined();
    expect(driverReturn.blockers).toBeDefined();
    expect(driverReturn.referenced_experiences).toBeDefined();
    expect(driverReturn.assumptions).toBeDefined();
  });

  it('falls back when LLM throws an error', async () => {
    const mockLlm = new MockLlmClient([{ response: 'ERROR:API rate limit exceeded' }]);

    const mapper = new LlmDriverResultMapper(mockLlm);
    const result = makeDriverRunResult();
    const input = makeInvokeInput();

    const driverReturn = await mapper.map(result, input);

    // 降级成功：启发式映射器仍返回 6 字段
    expect(driverReturn).toHaveProperty('artifacts');
    expect(driverReturn).toHaveProperty('summary');
    expect(driverReturn).toHaveProperty('decisions');
    expect(driverReturn).toHaveProperty('blockers');
    expect(driverReturn).toHaveProperty('referenced_experiences');
    expect(driverReturn).toHaveProperty('assumptions');
  });

  it('falls back when LLM response is valid JSON but missing fields', async () => {
    const mockLlm = new MockLlmClient([
      {
        // 缺少 decisions 数组
        response: JSON.stringify({
          artifacts: [],
          summary: 'Done.',
          blockers: [],
          assumptions: [],
        }),
      },
    ]);

    const mapper = new LlmDriverResultMapper(mockLlm);
    const result = makeDriverRunResult();
    const input = makeInvokeInput();

    const driverReturn = await mapper.map(result, input);

    // 降级成功
    expect(driverReturn.artifacts).toBeDefined();
    expect(driverReturn.summary).toBeDefined();
    expect(driverReturn.decisions).toBeDefined();
  });

  it('falls back when LLM response has empty summary string', async () => {
    const mockLlm = new MockLlmClient([
      {
        response: JSON.stringify({
          artifacts: [],
          summary: '',
          decisions: [],
          blockers: [],
          assumptions: [],
        }),
      },
    ]);

    const mapper = new LlmDriverResultMapper(mockLlm);
    const result = makeDriverRunResult();
    const input = makeInvokeInput();

    const driverReturn = await mapper.map(result, input);

    // 降级成功
    expect(driverReturn.summary.length).toBeGreaterThan(0);
  });

  it('falls back when LLM response has artifact missing type', async () => {
    const mockLlm = new MockLlmClient([
      {
        response: JSON.stringify({
          artifacts: [{ path: '/x', summary: 'x' }], // missing type
          summary: 'Done.',
          decisions: [],
          blockers: [],
          assumptions: [],
        }),
      },
    ]);

    const mapper = new LlmDriverResultMapper(mockLlm);
    const result = makeDriverRunResult();
    const input = makeInvokeInput();

    const driverReturn = await mapper.map(result, input);

    // 降级成功
    expect(driverReturn.artifacts).toBeDefined();
  });

  it('falls back when LLM response has blocker missing resolved boolean', async () => {
    const mockLlm = new MockLlmClient([
      {
        response: JSON.stringify({
          artifacts: [],
          summary: 'Done.',
          decisions: [],
          blockers: [{ blocker: 'x', attempts: [], resolution: 'y' }], // missing resolved
          assumptions: [],
        }),
      },
    ]);

    const mapper = new LlmDriverResultMapper(mockLlm);
    const result = makeDriverRunResult();
    const input = makeInvokeInput();

    const driverReturn = await mapper.map(result, input);

    // 降级成功
    expect(driverReturn.blockers).toBeDefined();
  });
});

// ═══════════════════════════════════════════
// §3 DriverAdapter 集成
// ═══════════════════════════════════════════

describe('LlmDriverResultMapper — DriverAdapter integration', () => {
  it('plugs into DriverAdapter as custom mapResult', async () => {
    const { DriverAdapter } = await import('../adapters/driver-adapter');
    const { MockDriver } = await import('../../driver');

    const mockLlm = new MockLlmClient([
      {
        match: /Fix SQL injection/,
        response: makeValidLlmResponse({
          summary: 'LLM-extracted: fixed SQL injection via parameterized queries.',
        }),
      },
    ]);

    const mapper = new LlmDriverResultMapper(mockLlm);
    const mockDriver = new MockDriver();
    const adapter = new DriverAdapter({
      driverRuntime: mockDriver,
      mapResult: mapper.map,
    });

    const input = makeInvokeInput({
      task_id: 'task_llm_integration',
      call_id: 'call_llm_integration',
      driver_context: makeDriverContext({
        task_instruction: 'Fix SQL injection in auth module.',
      }),
    });

    const driverReturn = await adapter.invoke(input);

    // 走完整链路：序列化 → MockDriver.sendPrompt → LLM 映射
    expect(driverReturn.summary).toContain('LLM-extracted');
    expect(driverReturn.decisions[0]!.point).toBe('Fix strategy for SQL injection');
    expect(driverReturn.referenced_experiences).toEqual([]);
    expect(driverReturn.assumptions.length).toBeGreaterThan(0);
  });
});
