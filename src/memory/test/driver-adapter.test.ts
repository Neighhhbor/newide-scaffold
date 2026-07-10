/**
 * DriverAdapter 单元测试
 *
 * 覆盖三层转换：
 * 1. serializeDriverContext — DriverContext → prompt 字符串
 * 2. mapRunResultToDriverReturn — DriverRunResult → DriverReturn
 * 3. DriverAdapter.invoke — 端到端适配调用（集成 MockDriver）
 */
import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, createId } from '../../core';
import type { DriverPrompt, DriverRunResult } from '../../driver';
import { MockDriver } from '../../driver';
import {
  DriverAdapter,
  createDriverInvoker,
  serializeDriverContext,
  mapRunResultToDriverReturn,
  type DriverContextSerializer,
  type DriverResultMapper,
} from '../adapters/driver-adapter';
import type { DriverInvokeInput } from '../runtime/agent-run-deps';
import type { DriverContext } from '../types';
import type { ExperienceRecord, SkillRecord } from '../schemas';

// ═══════════════════════════════════════════
// Helpers — 构建测试数据
// ═══════════════════════════════════════════

function makeSkill(overrides: Partial<SkillRecord> = {}): SkillRecord {
  return {
    id: 'skill-1',
    description: 'Parameterized query remediation',
    description_embedding: [],
    content: 'Step 1. Identify concatenation points.\nStep 2. Replace with parameterized queries.',
    version: '1.0.0',
    review_status: 'approved',
    tags: ['security', 'sql'],
    promoted_at: '2026-06-01T00:00:00.000Z',
    agent_id: 'role_a',
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeExperience(overrides: Partial<ExperienceRecord> = {}): ExperienceRecord {
  return {
    id: 'exp-1',
    description: 'Legacy ORM driver incompatibility',
    description_embedding: [],
    content: 'When applying parameterized queries, verify driver compatibility first.',
    confidence: 0.85,
    tags: ['sql', 'legacy'],
    agent_id: 'role_a',
    type: 'positive',
    confidence_history: [],
    referenced_count: 2,
    source_task_id: 'task_001',
    source_driver: 'mock-driver',
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

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
    source_driver: 'mock-driver',
    driver_context: makeDriverContext(),
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
        producer_id: 'mock-driver',
        task_id: 'task_test',
        created_at,
        schema_version: SCHEMA_VERSION,
      },
    ],
    transcript_ref: {
      artifact_id: createId('artifact'),
      type: 'transcript',
      uri: 'artifact://transcript/task_test/session',
      producer_id: 'mock-driver',
      task_id: 'task_test',
      created_at,
      schema_version: SCHEMA_VERSION,
    },
    tool_events: [],
    diagnostics: {
      driver_id: 'mock-driver',
      duration_ms: 10,
      notes: ['Mock driver completed successfully.'],
    },
    created_at,
    schema_version: SCHEMA_VERSION,
    ...overrides,
  };
}

// ═══════════════════════════════════════════
// §1 serializeDriverContext
// ═══════════════════════════════════════════

describe('serializeDriverContext', () => {
  it('outputs task_instruction as ## Task section', () => {
    const context = makeDriverContext({ task_instruction: 'Fix all the bugs.' });
    const input = makeInvokeInput({ driver_context: context });

    const prompt = serializeDriverContext(context, input);

    expect(prompt).toContain('## Task');
    expect(prompt).toContain('Fix all the bugs.');
    // 只含 task_instruction 时不输出 Skills 和 Experiences 段
    expect(prompt).not.toContain('## Reference Skills');
    expect(prompt).not.toContain('## Reference Experiences');
    // 始终输出 Reporting 段
    expect(prompt).toContain('## Reporting');
    expect(prompt).toContain('A summary of what was done');
  });

  it('serializes skills with description, version, tags, and content', () => {
    const skill = makeSkill({
      id: 'skill-sql',
      description: 'SQL injection fix',
      content: 'Use parameterized queries.',
      version: '2.0.0',
      review_status: 'approved',
      tags: ['security'],
    });
    const context = makeDriverContext({ skills: [skill] });
    const input = makeInvokeInput({ driver_context: context });

    const prompt = serializeDriverContext(context, input);

    expect(prompt).toContain('## Reference Skills');
    expect(prompt).toContain('validated through repeated successful use');
    expect(prompt).toContain('### Skill [skill-sql]');
    expect(prompt).toContain('SQL injection fix');
    expect(prompt).toContain('**Version**: 2.0.0');
    expect(prompt).toContain('**Status**: approved');
    expect(prompt).toContain('**Tags**: security');
    expect(prompt).toContain('Use parameterized queries.');
  });

  it('serializes skill with linked_negative_exp caveat when present', () => {
    const skill = makeSkill({
      linked_negative_exp: ['neg-1', 'neg-2'],
    });
    const context = makeDriverContext({ skills: [skill] });
    const input = makeInvokeInput({ driver_context: context });

    const prompt = serializeDriverContext(context, input);

    expect(prompt).toContain('⚠️ **Caveats**');
    expect(prompt).toContain('2 negative experience(s)');
  });

  it('serializes skill without caveat when linked_negative_exp is absent', () => {
    const skill = makeSkill();
    const context = makeDriverContext({ skills: [skill] });
    const input = makeInvokeInput({ driver_context: context });

    const prompt = serializeDriverContext(context, input);

    expect(prompt).not.toContain('⚠️ **Caveats**');
  });

  it('serializes experiences with confidence, type, tags, and content', () => {
    const exp = makeExperience({
      id: 'exp-auth',
      description: 'Auth module fix pattern',
      content: 'Always validate tokens.',
      confidence: 0.92,
      type: 'positive',
      tags: ['auth', 'security'],
      assumptions: ['Uses JWT tokens'],
    });
    const context = makeDriverContext({ experiences: [exp] });
    const input = makeInvokeInput({ driver_context: context });

    const prompt = serializeDriverContext(context, input);

    expect(prompt).toContain('## Reference Experiences');
    expect(prompt).toContain('extracted from past tasks');
    expect(prompt).toContain('### Experience [exp-auth] (confidence: 92%)');
    expect(prompt).toContain('Auth module fix pattern');
    expect(prompt).toContain('**Type**: positive');
    expect(prompt).toContain('**Tags**: auth, security');
    expect(prompt).toContain('**Assumptions**: Uses JWT tokens');
    expect(prompt).toContain('Always validate tokens.');
  });

  it('serializes experience with linked_negative_exp caveat', () => {
    const exp = makeExperience({
      type: 'positive',
      linked_negative_exp: ['neg-3'],
    });
    const context = makeDriverContext({ experiences: [exp] });
    const input = makeInvokeInput({ driver_context: context });

    const prompt = serializeDriverContext(context, input);

    expect(prompt).toContain('⚠️ **Linked caveats**');
    expect(prompt).toContain('1 associated negative experience');
  });

  it('serializes negative experience without caveats section', () => {
    const exp = makeExperience({
      type: 'negative',
      linked_negative_exp: undefined,
    });
    const context = makeDriverContext({ experiences: [exp] });
    const input = makeInvokeInput({ driver_context: context });

    const prompt = serializeDriverContext(context, input);

    expect(prompt).not.toContain('⚠️ **Linked caveats**');
  });

  it('sorts skills before experiences regardless of array order', () => {
    const skill1 = makeSkill({ id: 'skill-first', description: 'Skill A' });
    const exp1 = makeExperience({ id: 'exp-first', description: 'Experience A' });
    const context = makeDriverContext({ skills: [skill1], experiences: [exp1] });
    const input = makeInvokeInput({ driver_context: context });

    const prompt = serializeDriverContext(context, input);

    const skillIndex = prompt.indexOf('## Reference Skills');
    const expIndex = prompt.indexOf('## Reference Experiences');
    expect(skillIndex).toBeLessThan(expIndex);
  });

  it('outputs empty prompt sections when skills and experiences are empty', () => {
    const context = makeDriverContext();
    const input = makeInvokeInput({ driver_context: context });

    const prompt = serializeDriverContext(context, input);

    expect(prompt).toContain('## Task');
    expect(prompt).toContain('## Reporting');
    expect(prompt).not.toContain('## Reference Skills');
    expect(prompt).not.toContain('## Reference Experiences');
  });
});

// ═══════════════════════════════════════════
// §2 mapRunResultToDriverReturn
// ═══════════════════════════════════════════

describe('mapRunResultToDriverReturn', () => {
  it('maps artifacts from DriverRunResult.artifacts', () => {
    const result = makeDriverRunResult({
      artifacts: [
        {
          artifact_id: createId('artifact'),
          type: 'patch',
          uri: 'artifact://patch/task_test/fix.patch',
          producer_id: 'mock-driver',
          task_id: 'task_test',
          created_at: '2026-07-09T00:00:01.000Z',
          schema_version: SCHEMA_VERSION,
        },
      ],
    });
    const input = makeInvokeInput();

    const driverReturn = mapRunResultToDriverReturn(result, input);

    expect(driverReturn.artifacts).toHaveLength(1);
    expect(driverReturn.artifacts[0]!).toMatchObject({
      type: 'patch',
      path: 'artifact://patch/task_test/fix.patch',
    });
    expect(driverReturn.artifacts[0]!.summary).toContain('patch');
  });

  it('uses metadata.summary in artifact when present', () => {
    const result = makeDriverRunResult({
      artifacts: [
        {
          artifact_id: createId('artifact'),
          type: 'patch',
          uri: 'artifact://patch/task_test/fix.patch',
          producer_id: 'mock-driver',
          task_id: 'task_test',
          metadata: { summary: 'Fixed SQL injection in login.ts' },
          created_at: '2026-07-09T00:00:01.000Z',
          schema_version: SCHEMA_VERSION,
        },
      ],
    });
    const input = makeInvokeInput();

    const driverReturn = mapRunResultToDriverReturn(result, input);

    expect(driverReturn.artifacts[0]!.summary).toBe('Fixed SQL injection in login.ts');
  });

  it('builds summary from diagnostics and status', () => {
    const result = makeDriverRunResult({
      status: 'succeeded',
      diagnostics: {
        driver_id: 'mock-driver',
        duration_ms: 42,
        notes: ['Applied parameterized query fix.', 'Ran 12 tests.'],
      },
    });
    const input = makeInvokeInput();

    const driverReturn = mapRunResultToDriverReturn(result, input);

    expect(driverReturn.summary).toContain('status: succeeded');
    expect(driverReturn.summary).toContain('Applied parameterized query fix.');
    expect(driverReturn.summary).toContain('Ran 12 tests.');
  });

  it('includes error in summary when present', () => {
    const result = makeDriverRunResult({
      status: 'failed',
      error: { code: 'TIMEOUT', message: 'Task exceeded 60s limit', retryable: true },
    });
    const input = makeInvokeInput();

    const driverReturn = mapRunResultToDriverReturn(result, input);

    expect(driverReturn.summary).toContain('status: failed');
    expect(driverReturn.summary).toContain('[TIMEOUT]');
    expect(driverReturn.summary).toContain('Task exceeded 60s limit');
  });

  it('infers decisions from completed and failed tool_events', () => {
    const result = makeDriverRunResult({
      tool_events: [
        {
          tool_event_id: createId('tool_event'),
          tool_name: 'write_file',
          status: 'completed',
          summary: 'Wrote auth/login.ts with parameterized query',
          created_at: '2026-07-09T00:00:01.000Z',
          schema_version: SCHEMA_VERSION,
        },
        {
          tool_event_id: createId('tool_event'),
          tool_name: 'run_tests',
          status: 'completed',
          summary: 'Executed 12 test cases',
          created_at: '2026-07-09T00:00:02.000Z',
          schema_version: SCHEMA_VERSION,
        },
        {
          tool_event_id: createId('tool_event'),
          tool_name: 'read_file',
          status: 'in_progress', // ← 不进入 decisions
          summary: 'Reading config',
          created_at: '2026-07-09T00:00:00.500Z',
          schema_version: SCHEMA_VERSION,
        },
      ],
    });
    const input = makeInvokeInput();

    const driverReturn = mapRunResultToDriverReturn(result, input);

    expect(driverReturn.decisions).toHaveLength(2);
    expect(driverReturn.decisions[0]).toMatchObject({
      point: 'Driver invoked tool: write_file',
      chosen: 'execute',
      reason: 'Wrote auth/login.ts with parameterized query',
    });
    expect(driverReturn.decisions[1]).toMatchObject({
      point: 'Driver invoked tool: run_tests',
      chosen: 'execute',
      reason: 'Executed 12 test cases',
    });
  });

  it('marks failed tool events as blockers', () => {
    const result = makeDriverRunResult({
      tool_events: [
        {
          tool_event_id: createId('tool_event'),
          tool_name: 'npm_install',
          status: 'failed',
          summary: 'npm install failed: EACCES',
          created_at: '2026-07-09T00:00:01.000Z',
          schema_version: SCHEMA_VERSION,
        },
        {
          tool_event_id: createId('tool_event'),
          tool_name: 'write_file',
          status: 'completed',
          summary: 'Wrote fix',
          created_at: '2026-07-09T00:00:02.000Z',
          schema_version: SCHEMA_VERSION,
        },
      ],
    });
    const input = makeInvokeInput();

    const driverReturn = mapRunResultToDriverReturn(result, input);

    expect(driverReturn.blockers).toHaveLength(1);
    expect(driverReturn.blockers[0]!).toMatchObject({
      blocker: 'Tool "npm_install" failed',
      resolved: false,
    });
    expect(driverReturn.blockers[0]!.attempts).toContain('npm install failed: EACCES');
  });

  it('derives blocker from error when no tool_event failed', () => {
    const result = makeDriverRunResult({
      error: { code: 'AUTH_ERROR', message: 'Invalid API key', retryable: false },
      tool_events: [],
    });
    const input = makeInvokeInput();

    const driverReturn = mapRunResultToDriverReturn(result, input);

    expect(driverReturn.blockers).toHaveLength(1);
    expect(driverReturn.blockers[0]!.blocker).toContain('AUTH_ERROR');
    expect(driverReturn.blockers[0]!.resolution).toContain('Non-retryable');
  });

  it('marks error blocker as retryable when DriverError.retryable is true', () => {
    const result = makeDriverRunResult({
      error: { code: 'TIMEOUT', message: 'Exceeded limit', retryable: true },
      tool_events: [],
    });
    const input = makeInvokeInput();

    const driverReturn = mapRunResultToDriverReturn(result, input);

    expect(driverReturn.blockers[0]!.resolution).toContain('Retryable');
  });

  it('builds referenced_experiences from input.driver_context.experiences', () => {
    const exp1 = makeExperience({ id: 'exp-ref-1', description: 'Ref exp 1' });
    const exp2 = makeExperience({ id: 'exp-ref-2', description: 'Ref exp 2' });
    const context = makeDriverContext({ experiences: [exp1, exp2] });
    const input = makeInvokeInput({ driver_context: context });

    const result = makeDriverRunResult();
    const driverReturn = mapRunResultToDriverReturn(result, input);

    expect(driverReturn.referenced_experiences).toHaveLength(2);
    expect(driverReturn.referenced_experiences[0]).toMatchObject({
      experience_id: 'exp-ref-1',
      applied: true,
      effectiveness: 'not_applicable',
    });
    expect(driverReturn.referenced_experiences[0]!.note).toContain('Automatic mapping');
    expect(driverReturn.referenced_experiences[1]).toMatchObject({
      experience_id: 'exp-ref-2',
      applied: true,
      effectiveness: 'not_applicable',
    });
  });

  it('yields empty referenced_experiences when driver_context has no experiences', () => {
    const input = makeInvokeInput();
    const result = makeDriverRunResult();

    const driverReturn = mapRunResultToDriverReturn(result, input);

    expect(driverReturn.referenced_experiences).toEqual([]);
  });

  it('includes basic assumption about instruction correctness', () => {
    const input = makeInvokeInput();
    const result = makeDriverRunResult();

    const driverReturn = mapRunResultToDriverReturn(result, input);

    const basicAssumption = driverReturn.assumptions.find(
      (a) => a.assumption === 'Driver received complete and correct task instruction',
    );
    expect(basicAssumption).toBeDefined();
    expect(basicAssumption!.risk_if_wrong).toContain('incomplete or misdirected');
  });

  it('extracts assumptions from task_instruction with Chinese markers', () => {
    const context = makeDriverContext({
      task_instruction: '修复SQL注入。假设：目标数据库为MySQL 8.0。前提：用户具有root权限。',
    });
    const input = makeInvokeInput({ driver_context: context });
    const result = makeDriverRunResult();

    const driverReturn = mapRunResultToDriverReturn(result, input);

    const mysqlAssumption = driverReturn.assumptions.find(
      (a) => a.assumption === '目标数据库为MySQL 8.0',
    );
    const rootAssumption = driverReturn.assumptions.find(
      (a) => a.assumption === '用户具有root权限',
    );
    expect(mysqlAssumption).toBeDefined();
    expect(rootAssumption).toBeDefined();
  });

  it('extracts assumptions from task_instruction with English markers', () => {
    const context = makeDriverContext({
      task_instruction: 'Given the target is Node.js 22, Assume: PostgreSQL 15 is available.',
    });
    const input = makeInvokeInput({ driver_context: context });
    const result = makeDriverRunResult();

    const driverReturn = mapRunResultToDriverReturn(result, input);

    const pgAssumption = driverReturn.assumptions.find(
      (a) => a.assumption === 'PostgreSQL 15 is available',
    );
    expect(pgAssumption).toBeDefined();
  });

  it('returns complete 6-field structure even for empty result', () => {
    const result = makeDriverRunResult({ artifacts: [], tool_events: [] });
    const input = makeInvokeInput();

    const driverReturn = mapRunResultToDriverReturn(result, input);

    expect(driverReturn).toHaveProperty('artifacts');
    expect(driverReturn).toHaveProperty('summary');
    expect(driverReturn).toHaveProperty('decisions');
    expect(driverReturn).toHaveProperty('blockers');
    expect(driverReturn).toHaveProperty('referenced_experiences');
    expect(driverReturn).toHaveProperty('assumptions');
    expect(driverReturn.artifacts).toEqual([]);
    expect(driverReturn.decisions).toEqual([]);
    expect(driverReturn.blockers).toEqual([]);
  });
});

// ═══════════════════════════════════════════
// §3 DriverAdapter.invoke (集成 MockDriver)
// ═══════════════════════════════════════════

describe('DriverAdapter', () => {
  it('serializes context → sends to MockDriver → maps result to DriverReturn', async () => {
    const mockDriver = new MockDriver();
    const adapter = new DriverAdapter({ driverRuntime: mockDriver });

    const exp = makeExperience({
      id: 'exp-int-1',
      description: 'Integration test experience',
      content: 'Integration test body.',
    });
    const skill = makeSkill({
      id: 'skill-int-1',
      description: 'Integration test skill',
      content: 'Skill body.',
    });
    const input = makeInvokeInput({
      task_id: 'task_integration',
      call_id: 'call_integration',
      driver_context: makeDriverContext({
        task_instruction: 'Run integration test.',
        skills: [skill],
        experiences: [exp],
      }),
    });

    const driverReturn = await adapter.invoke(input);

    // 6 字段结构完整
    expect(driverReturn.artifacts.length).toBeGreaterThan(0);
    expect(driverReturn.summary.length).toBeGreaterThan(0);
    expect(driverReturn.referenced_experiences).toHaveLength(1);
    expect(driverReturn.referenced_experiences[0]!.experience_id).toBe('exp-int-1');
    expect(driverReturn.referenced_experiences[0]!.effectiveness).toBe('not_applicable');
    expect(driverReturn.assumptions.length).toBeGreaterThan(0);
  });

  it('exposes underlying runtime for inspection', () => {
    const mockDriver = new MockDriver();
    const adapter = new DriverAdapter({ driverRuntime: mockDriver });

    expect(adapter.runtime).toBe(mockDriver);
    expect(adapter.runtime.driver_id).toBe('mock-driver');
  });

  it('accepts custom serializer to change prompt format', async () => {
    const mockDriver = new MockDriver();
    let serializedPrompt = '';
    const customSerialize: DriverContextSerializer = (ctx, input) => {
      const result = `CUSTOM:${ctx.task_instruction}:${input.task_id}`;
      serializedPrompt = result;
      return result;
    };

    const adapter = new DriverAdapter({
      driverRuntime: mockDriver,
      serializeContext: customSerialize,
    });

    const input = makeInvokeInput({
      task_id: 'task_custom_serialize',
      driver_context: makeDriverContext({ task_instruction: 'Custom serialize test.' }),
    });

    await adapter.invoke(input);

    expect(serializedPrompt).toBe('CUSTOM:Custom serialize test.:task_custom_serialize');
  });

  it('accepts custom mapper to override default result mapping', async () => {
    const mockDriver = new MockDriver();
    const customMapper: DriverResultMapper = (_result, _input) => ({
      artifacts: [{ type: 'custom', path: '/dev/null', summary: 'Custom mapping applied.' }],
      summary: 'Custom summary.',
      decisions: [{ point: 'custom', options: ['a', 'b'], chosen: 'a', reason: 'custom reason' }],
      blockers: [],
      referenced_experiences: [],
      assumptions: [],
    });

    const adapter = new DriverAdapter({
      driverRuntime: mockDriver,
      mapResult: customMapper,
    });

    const input = makeInvokeInput();
    const driverReturn = await adapter.invoke(input);

    expect(driverReturn.artifacts[0]!.type).toBe('custom');
    expect(driverReturn.artifacts[0]!.summary).toBe('Custom mapping applied.');
    expect(driverReturn.summary).toBe('Custom summary.');
    expect(driverReturn.decisions[0]!.point).toBe('custom');
    expect(driverReturn.referenced_experiences).toEqual([]);
  });

  it('propagates errors from sendPrompt without catching', async () => {
    const mockDriverInstance = new MockDriver();
    const failingDriver = {
      ...mockDriverInstance,
      sendPrompt: async (_input: DriverPrompt): Promise<DriverRunResult> => {
        throw new Error('Simulated driver failure');
      },
      interrupt: mockDriverInstance.interrupt.bind(mockDriverInstance),
      collectTranscript: mockDriverInstance.collectTranscript.bind(mockDriverInstance),
    };

    const adapter = new DriverAdapter({ driverRuntime: failingDriver });
    const input = makeInvokeInput();

    await expect(adapter.invoke(input)).rejects.toThrow('Simulated driver failure');
  });

  it('createDriverInvoker returns a function with correct signature', async () => {
    const mockDriver = new MockDriver();
    const invoker = createDriverInvoker({ driverRuntime: mockDriver });

    const input = makeInvokeInput({
      task_id: 'task_factory',
      call_id: 'call_factory',
    });

    const driverReturn = await invoker(input);

    expect(driverReturn).toHaveProperty('artifacts');
    expect(driverReturn).toHaveProperty('summary');
    expect(driverReturn).toHaveProperty('decisions');
    expect(driverReturn).toHaveProperty('blockers');
    expect(driverReturn).toHaveProperty('referenced_experiences');
    expect(driverReturn).toHaveProperty('assumptions');
  });
});
