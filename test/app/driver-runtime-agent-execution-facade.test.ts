import { describe, expect, it, vi } from 'vitest';
import { DriverRuntimeAgentExecutionFacade } from '../../src/app/driver-runtime-agent-execution-facade';
import { SCHEMA_VERSION, type ArtifactRef } from '../../src/core';
import {
  MockDriver,
  type DriverCapabilities,
  type DriverPrompt,
  type DriverRunResult,
  type DriverRuntimeHandle,
} from '../../src/driver';
import { InMemoryBufferRepository, InMemoryRepository } from '../../src/memory';

describe('DriverRuntimeAgentExecutionFacade', () => {
  it('runs the real driver through the public B runtime and preserves the execution result', async () => {
    const driver = new CapturingDriver('succeeded');
    const { facade, buffer } = createFacade(driver);

    const result = await facade.runAgent(request('task_001', 'proposer_a'));

    expect(driver.prompts).toHaveLength(1);
    expect(driver.prompts[0]).toMatchObject({
      task_id: 'task_001',
      run_id: 'run_task_001',
      schema_version: SCHEMA_VERSION,
    });
    expect(result).toMatchObject({
      agent_run_id: expect.stringMatching(/^agent_run_/),
      role_id: 'proposer_a',
      context_pack_ref: expect.stringMatching(/^context_pack_/),
      driver_run_result_id: 'driver_result_001',
      artifact_refs: [createArtifact('artifact_output_001')],
      transcript_ref: createArtifact('artifact_transcript_001', 'transcript'),
      diagnostics: {
        driver_id: 'driver_001',
        driver_status: 'succeeded',
        context_policy: 'default',
        input_artifact_refs: [],
        buffer_seq: 1,
      },
      status: 'completed',
      memory_buffer_ref: 'proposer_a:1',
      schema_version: SCHEMA_VERSION,
    });
    expect((await buffer.getBufferMeta('proposer_a')).total_processed).toBe(1);
  });

  it.each([
    ['failed', 'failed'],
    ['cancelled', 'cancelled'],
    ['interrupted', 'interrupted'],
  ] as const)('maps %s driver results to %s agent results', async (driverStatus, agentStatus) => {
    const { facade } = createFacade(new CapturingDriver(driverStatus));

    const result = await facade.runAgent(request('task_status', 'reviewer'));

    expect(result.status).toBe(agentStatus);
    expect(result.diagnostics).toMatchObject({ driver_status: driverStatus });
    if (driverStatus === 'failed') {
      expect(result.diagnostics).toMatchObject({ driver_error_code: 'MOCK_FAILED' });
    }
  });

  it('keeps role memory isolated while reusing each role runtime', async () => {
    const driver = new CapturingDriver('succeeded');
    const { facade } = createFacade(driver);

    const proposerFirst = await facade.runAgent(request('task_p1', 'proposer'));
    const reviewer = await facade.runAgent(request('task_r1', 'reviewer'));
    const proposerSecond = await facade.runAgent(request('task_p2', 'proposer'));

    expect(proposerFirst.memory_buffer_ref).toBe('proposer:1');
    expect(reviewer.memory_buffer_ref).toBe('reviewer:1');
    expect(proposerSecond.memory_buffer_ref).toBe('proposer:2');
  });

  it('serializes executions for the same role outside the B runtime', async () => {
    const driver = new ConcurrentDriver();
    const { facade } = createFacade(driver);

    await Promise.all([
      facade.runAgent(request('task_serial_1', 'proposer')),
      facade.runAgent(request('task_serial_2', 'proposer')),
    ]);

    expect(driver.maxActive).toBe(1);
  });

  it('rejects a pre-aborted execution without calling the driver or writing a buffer', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('already cancelled', 'AbortError'));
    const driver = new CapturingDriver('succeeded');
    const { facade, buffer } = createFacade(driver);

    await expect(
      facade.runAgent(request('pre_abort', 'proposer_a'), { signal: controller.signal }),
    ).rejects.toThrow('already cancelled');
    expect(driver.prompts).toHaveLength(0);
    expect((await buffer.getBufferMeta('proposer_a')).total_processed).toBe(0);
  });

  it('interrupts the real driver when the execution signal is aborted', async () => {
    const controller = new AbortController();
    const driver = new MockDriver();
    driver.sendPrompt = vi.fn(() => new Promise<DriverRunResult>(() => undefined));
    const interrupt = vi.spyOn(driver, 'interrupt');
    const { facade, buffer } = createFacade(driver);

    const running = facade.runAgent(request('task_cancel', 'proposer_a'), {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(driver.sendPrompt).toHaveBeenCalledTimes(1));
    controller.abort(new Error('Cancel B runtime execution'));

    await expect(running).rejects.toThrow('Cancel B runtime execution');
    expect(interrupt).toHaveBeenCalledWith('Cancel B runtime execution');
    expect((await buffer.getBufferMeta('proposer_a')).total_processed).toBe(0);
  });

  it('does not retroactively cancel after the driver has completed', async () => {
    const controller = new AbortController();
    const buffer = new DelayedBufferRepository();
    const { facade } = createFacade(new CapturingDriver('succeeded'), buffer);

    const running = facade.runAgent(request('late_abort', 'proposer_a'), {
      signal: controller.signal,
    });
    await buffer.saveStarted;
    controller.abort(new Error('Too late to cancel the completed driver'));
    buffer.continueSave();

    await expect(running).resolves.toMatchObject({ status: 'completed' });
    expect((await buffer.getBufferMeta('proposer_a')).total_processed).toBe(1);
  });
});

function createFacade(
  driver: DriverRuntimeHandle,
  buffer: InMemoryBufferRepository = new InMemoryBufferRepository(),
) {
  const repository = new InMemoryRepository();
  return {
    facade: new DriverRuntimeAgentExecutionFacade({
      driver,
      repository,
      bufferRepository: buffer,
    }),
    buffer,
  };
}

class DelayedBufferRepository extends InMemoryBufferRepository {
  private saveStartedResolve!: () => void;
  private continueSaveResolve!: () => void;
  readonly saveStarted = new Promise<void>((resolve) => {
    this.saveStartedResolve = resolve;
  });
  private readonly saveContinues = new Promise<void>((resolve) => {
    this.continueSaveResolve = resolve;
  });

  continueSave(): void {
    this.continueSaveResolve();
  }

  override async saveBufferSnapshot(
    ...args: Parameters<InMemoryBufferRepository['saveBufferSnapshot']>
  ): ReturnType<InMemoryBufferRepository['saveBufferSnapshot']> {
    this.saveStartedResolve();
    await this.saveContinues;
    return super.saveBufferSnapshot(...args);
  }
}

function request(taskId: string, roleId: string) {
  return {
    task_id: taskId,
    run_id: `run_${taskId}`,
    role_id: roleId,
    instruction: 'Execute through B runtime.',
    input_artifact_refs: [],
    context_policy: 'default',
    schema_version: SCHEMA_VERSION,
  };
}

class CapturingDriver implements DriverRuntimeHandle {
  readonly driver_id = 'driver_001';
  readonly session_id = 'session_001';
  readonly capabilities: DriverCapabilities = {
    supports_acp_extension: false,
    supports_structured_output: true,
    supports_session_load: false,
    supports_tool_events: false,
    supports_permission_events: false,
  };
  readonly prompts: DriverPrompt[] = [];

  constructor(private readonly status: DriverRunResult['status']) {}

  async sendPrompt(input: DriverPrompt): Promise<DriverRunResult> {
    this.prompts.push(input);
    return driverResult(this, this.status);
  }

  async interrupt(_reason: string): Promise<void> {}

  async collectTranscript(): Promise<ArtifactRef> {
    return createArtifact('artifact_transcript_001', 'transcript');
  }
}

class ConcurrentDriver extends CapturingDriver {
  active = 0;
  maxActive = 0;

  constructor() {
    super('succeeded');
  }

  override async sendPrompt(input: DriverPrompt): Promise<DriverRunResult> {
    this.prompts.push(input);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    this.active -= 1;
    return driverResult(this, 'succeeded');
  }
}

function driverResult(
  driver: DriverRuntimeHandle,
  status: DriverRunResult['status'],
): DriverRunResult {
  return {
    driver_run_result_id: 'driver_result_001',
    session_id: driver.session_id,
    status,
    artifacts: status === 'succeeded' ? [createArtifact('artifact_output_001')] : [],
    transcript_ref: createArtifact('artifact_transcript_001', 'transcript'),
    tool_events: [],
    diagnostics: {
      driver_id: driver.driver_id,
      duration_ms: 25,
      notes: ['captured'],
    },
    ...(status === 'failed'
      ? {
          error: {
            code: 'MOCK_FAILED',
            message: 'Mock driver failed.',
            retryable: false,
          },
        }
      : {}),
    created_at: '2026-07-07T00:00:00.000Z',
    schema_version: SCHEMA_VERSION,
  };
}

function createArtifact(artifactId: string, type: ArtifactRef['type'] = 'patch'): ArtifactRef {
  return {
    artifact_id: artifactId,
    type,
    uri: `artifact://${type}/${artifactId}`,
    producer_id: 'driver_001',
    task_id: 'task_001',
    created_at: '2026-07-07T00:00:00.000Z',
    schema_version: SCHEMA_VERSION,
  };
}
