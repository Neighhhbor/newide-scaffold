import { describe, expect, it, vi } from 'vitest';
import { SCHEMA_VERSION, type ArtifactRef } from '../../src/core';
import type {
  DriverCapabilities,
  DriverPrompt,
  DriverRunResult,
  DriverRuntimeHandle,
} from '../../src/driver';
import {
  AgentManager,
  DriverRuntimeAgentExecutionFacade,
  InMemoryBufferRepository,
  InMemoryRepository,
  defaultMvpAgentRunDeps,
} from '../../src/memory';
import { createDriverRuntimeInvoker } from '../../src/driver';
import { MockDriver } from '../../src/driver/mock-driver';

describe('DriverRuntimeAgentExecutionFacade', () => {
  it('runs an agent through a DriverRuntimeHandle and returns an AgentExecutionResult', async () => {
    const driver = new CapturingDriver('succeeded');
    const { facade, buffer } = createFacade(driver);

    const result = await facade.runAgent({
      task_id: 'task_001',
      run_id: 'run_001',
      role_id: 'proposer_a',
      instruction: 'Produce a candidate implementation.',
      input_artifact_refs: ['artifact_input_001'],
      context_policy: 'default',
      schema_version: SCHEMA_VERSION,
    });

    expect(driver.prompts).toHaveLength(1);
    expect(driver.prompts[0]).toMatchObject({
      task_id: 'task_001',
      run_id: 'run_001',
      run_id: expect.stringMatching(/^call_/),
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
        input_artifact_refs: ['artifact_input_001'],
        buffer_seq: 1,
      },
      status: 'completed',
      schema_version: SCHEMA_VERSION,
    });
    expect(result.created_at).toEqual(expect.any(String));
    expect(result.memory_buffer_ref).toBe('proposer_a:1');
    expect((await buffer.getBufferMeta('proposer_a')).total_processed).toBe(1);
  });

  it.each([
    ['failed', 'failed'],
    ['cancelled', 'cancelled'],
    ['interrupted', 'interrupted'],
  ] as const)(
    'maps %s driver results to %s agent execution results',
    async (driverStatus, agentStatus) => {
      const driver = new CapturingDriver(driverStatus);
      const { facade } = createFacade(driver);

      const result = await facade.runAgent({
        task_id: 'task_001',
        run_id: 'run_001',
        role_id: 'reviewer',
        instruction: 'Review the candidate.',
        input_artifact_refs: [],
        context_policy: 'default',
        schema_version: SCHEMA_VERSION,
      });

      expect(result.status).toBe(agentStatus);
      expect(result.diagnostics).toMatchObject({
        driver_status: driverStatus,
      });
      if (driverStatus === 'failed')
        expect(result.diagnostics).toMatchObject({ driver_error_code: 'MOCK_FAILED' });
    },
  );

  it('rejects a pre-aborted execution without writing a buffer', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('already cancelled', 'AbortError'));
    const driver = new CapturingDriver('succeeded');
    const { facade, buffer } = createFacade(driver);

    await expect(
      facade.runAgent(request('pre_abort'), { signal: controller.signal }),
    ).rejects.toThrow('already cancelled');
    expect(driver.prompts).toHaveLength(0);
    expect((await buffer.getBufferMeta('proposer_a')).total_processed).toBe(0);
  });

  it('interrupts its driver when the execution signal is aborted', async () => {
    const controller = new AbortController();
    const driver = new MockDriver();
    driver.sendPrompt = vi.fn(() => new Promise<DriverRunResult>(() => undefined));
    const interrupt = vi.spyOn(driver, 'interrupt');
    const { facade, buffer, manager } = createFacade(driver);
    await manager.ensureAgent('proposer_a');

    const running = facade.runAgent(
      {
        task_id: 'task_cancel',
        run_id: 'run_cancel',
        role_id: 'proposer_a',
        instruction: 'Cancel this B runtime execution.',
        input_artifact_refs: [],
        context_policy: 'default',
        schema_version: SCHEMA_VERSION,
      },
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(driver.sendPrompt).toHaveBeenCalledTimes(1));
    controller.abort(new Error('Cancel B runtime execution'));

    await expect(running).rejects.toThrow('Cancel B runtime execution');
    expect(interrupt).toHaveBeenCalledWith('Cancel B runtime execution');
    expect((await buffer.getBufferMeta('proposer_a')).total_processed).toBe(0);
  });
});

function createFacade(driver: DriverRuntimeHandle) {
  const repository = new InMemoryRepository();
  const buffer = new InMemoryBufferRepository();
  const manager = AgentManager.create(repository, buffer, {
    ...defaultMvpAgentRunDeps,
    invokeDriver: createDriverRuntimeInvoker(driver),
  });
  return {
    facade: new DriverRuntimeAgentExecutionFacade({ manager, source_driver: driver.driver_id }),
    buffer,
    manager,
  };
}

function request(taskId: string) {
  return {
    task_id: taskId,
    run_id: `run_${taskId}`,
    role_id: 'proposer_a',
    instruction: 'Execute.',
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
    return {
      driver_run_result_id: 'driver_result_001',
      session_id: this.session_id,
      status: this.status,
      artifacts: this.status === 'succeeded' ? [createArtifact('artifact_output_001')] : [],
      transcript_ref: createArtifact('artifact_transcript_001', 'transcript'),
      tool_events: [],
      diagnostics: {
        driver_id: this.driver_id,
        duration_ms: 25,
        notes: ['captured'],
      },
      ...(this.status === 'failed'
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

  async interrupt(_reason: string): Promise<void> {}

  async collectTranscript(): Promise<ArtifactRef> {
    return createArtifact('artifact_transcript_001', 'transcript');
  }
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
