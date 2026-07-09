import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AuditController, MemoryAuditSink } from '../../src/litellm/contract';
import type { AuditSink } from '../../src/litellm/types';

describe('AuditController', () => {
  let audit: AuditController;
  let memorySink: MemoryAuditSink;

  beforeEach(() => {
    audit = new AuditController();
    memorySink = new MemoryAuditSink();
    audit.addSink(memorySink);
  });

  it('should record call start', async () => {
    const { end } = audit.startRecord('memory-compact', 'gpt-4o-mini', 2, ['query_memory']);

    await end({ usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } });

    const records = memorySink.getAll();
    expect(records).toHaveLength(1);
    expect(records[0].task).toBe('memory-compact');
    expect(records[0].model).toBe('gpt-4o-mini');
    expect(records[0].status).toBe('success');
    expect(records[0].usage?.total_tokens).toBe(150);
    expect(records[0].durationMs).toBeDefined();
  });

  it('should record call failure', async () => {
    const { end } = audit.startRecord('coordinate-plan', 'claude-sonnet', 3, []);

    await end({
      error: {
        code: 'TIMEOUT',
        message: 'Request timed out after 30000ms',
        retryable: true,
      },
    });

    const records = memorySink.getAll();
    expect(records[0].status).toBe('failed');
    expect(records[0].error?.code).toBe('TIMEOUT');
  });

  it('should support multiple sinks', async () => {
    const sink2: AuditSink = {
      onCallStart: vi.fn(),
      onCallSuccess: vi.fn(),
      onCallFailure: vi.fn(),
    };
    audit.addSink(sink2);

    const { end } = audit.startRecord('test-task', 'model', 1, []);
    await end({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });

    expect(sink2.onCallStart).toHaveBeenCalledOnce();
    expect(sink2.onCallSuccess).toHaveBeenCalledOnce();
  });

  it('should isolate errors in sinks', async () => {
    const badSink: AuditSink = {
      onCallStart: () => {
        throw new Error('sink error');
      },
      onCallSuccess: vi.fn(),
      onCallFailure: vi.fn(),
    };
    audit.addSink(badSink);

    // Should not throw despite bad sink
    const { end } = audit.startRecord('test', 'model', 1, []);
    await expect(
      end({ usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
    ).resolves.not.toThrow();
  });
});

describe('MemoryAuditSink', () => {
  let sink: MemoryAuditSink;

  beforeEach(() => {
    sink = new MemoryAuditSink();
  });

  it('should filter failures', async () => {
    sink.onCallStart({
      callId: '1',
      task: 't1',
      model: 'm1',
      messageCount: 1,
      toolNames: [],
      status: 'started',
      startTime: new Date(),
    });
    sink.onCallSuccess({
      callId: '1',
      task: 't1',
      model: 'm1',
      messageCount: 1,
      toolNames: [],
      status: 'success',
      startTime: new Date(),
      endTime: new Date(),
      durationMs: 100,
    });

    sink.onCallStart({
      callId: '2',
      task: 't2',
      model: 'm2',
      messageCount: 1,
      toolNames: [],
      status: 'started',
      startTime: new Date(),
    });
    sink.onCallFailure({
      callId: '2',
      task: 't2',
      model: 'm2',
      messageCount: 1,
      toolNames: [],
      status: 'failed',
      startTime: new Date(),
      endTime: new Date(),
      durationMs: 50,
      error: { code: 'ERR', message: 'fail', retryable: false },
    });

    expect(sink.getFailures()).toHaveLength(1);
    expect(sink.getFailures()[0].callId).toBe('2');
  });

  it('should filter by task', async () => {
    sink.onCallStart({
      callId: '1',
      task: 'memory-compact',
      model: 'm1',
      messageCount: 1,
      toolNames: [],
      status: 'started',
      startTime: new Date(),
    });
    sink.onCallSuccess({
      callId: '1',
      task: 'memory-compact',
      model: 'm1',
      messageCount: 1,
      toolNames: [],
      status: 'success',
      startTime: new Date(),
      endTime: new Date(),
      durationMs: 100,
    });

    sink.onCallStart({
      callId: '2',
      task: 'coordinate-plan',
      model: 'm2',
      messageCount: 1,
      toolNames: [],
      status: 'started',
      startTime: new Date(),
    });
    sink.onCallSuccess({
      callId: '2',
      task: 'coordinate-plan',
      model: 'm2',
      messageCount: 1,
      toolNames: [],
      status: 'success',
      startTime: new Date(),
      endTime: new Date(),
      durationMs: 100,
    });

    expect(sink.getByTask('memory-compact')).toHaveLength(1);
  });

  it('should clear records', () => {
    sink.onCallStart({
      callId: '1',
      task: 't',
      model: 'm',
      messageCount: 1,
      toolNames: [],
      status: 'started',
      startTime: new Date(),
    });
    sink.clear();
    expect(sink.getAll()).toHaveLength(0);
  });
});
