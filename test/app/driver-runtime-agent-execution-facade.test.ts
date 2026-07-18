import { describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DriverRuntimeAgentExecutionFacade } from '../../src/app/driver-runtime-agent-execution-facade';
import { FileAgentExecutionEvidenceStore } from '../../src/app/agent-execution-evidence-store';
import { SCHEMA_VERSION, type ArtifactRef } from '../../src/core';
import {
  MockDriver,
  type DriverCapabilities,
  type DriverPrompt,
  type DriverRunResult,
  type DriverRuntimeHandle,
} from '../../src/driver';
import {
  InMemoryBufferRepository,
  InMemoryRepository,
  type ToolCallingClient,
} from '../../src/memory';

describe('DriverRuntimeAgentExecutionFacade', () => {
  it('runs the real driver through the public B runtime and preserves the execution result', async () => {
    const driver = new CapturingDriver('succeeded');
    const { facade, buffer } = createFacade(driver);

    const result = await facade.runAgent(request('task_001', 'proposer_a', process.cwd()));

    expect(driver.prompts).toHaveLength(1);
    expect(driver.prompts[0]).toMatchObject({
      task_id: 'task_001',
      run_id: 'run_task_001',
      workspace_path: process.cwd(),
      session_id: 'session_existing',
      schema_version: SCHEMA_VERSION,
    });
    expect(result).toMatchObject({
      agent_run_id: expect.stringMatching(/^agent_run_/),
      agent_id: expect.stringMatching(/^proposer_a@[a-f0-9]{12}$/),
      role_id: 'proposer_a',
      context_pack_ref: expect.stringMatching(/^context_pack_[a-f0-9]{24}$/),
      driver_run_result_id: 'driver_result_001',
      artifact_refs: [createArtifact('artifact_output_001')],
      transcript_ref: createArtifact('artifact_transcript_001', 'transcript'),
      session_id: 'session_existing',
      response: 'Agent completed the requested change.',
      tool_events: [expect.objectContaining({ tool_event_id: 'tool_event_001' })],
      diagnostics: {
        driver_id: 'driver_001',
        driver_status: 'succeeded',
        context_policy: 'default',
        input_artifact_refs: [],
        buffer_seq: 1,
      },
      status: 'completed',
      memory_buffer_ref: expect.stringMatching(/^proposer_a@[a-f0-9]{12}:1$/),
      schema_version: SCHEMA_VERSION,
    });
    const scopedRole = result.memory_buffer_ref!.split(':')[0]!;
    expect(await buffer.getBufferMeta(scopedRole)).toMatchObject({
      pending_count: 1,
      total_processed: 0,
    });
  });

  it('resolves a relative workspace before crossing the B to A process boundary', async () => {
    const driver = new CapturingDriver('succeeded');
    const { facade } = createFacade(driver);
    const relativeWorkspace = '.newide/council/run_relative/proposer_a';

    await facade.runAgent(request('task_relative_workspace', 'proposer_a', relativeWorkspace));

    expect(driver.prompts[0]?.workspace_path).toBe(path.resolve(relativeWorkspace));
  });

  it('persists a content-addressed context pack with real retrieval and buffer evidence', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'newide-b-evidence-'));
    try {
      const driver = new CapturingDriver('succeeded');
      const facade = new DriverRuntimeAgentExecutionFacade({
        driver,
        repository: new InMemoryRepository(),
        bufferRepository: new InMemoryBufferRepository(),
        llm: invokeDriverLlm(),
        evidenceStore: new FileAgentExecutionEvidenceStore({ root }),
      });

      const result = await facade.runAgent(request('task_evidence', 'implementer'));

      expect(result).toMatchObject({
        agent_id: 'implementer',
        context_pack_ref: expect.stringMatching(/^context_pack_[a-f0-9]{24}$/),
        memory_buffer_ref: 'implementer:1',
        diagnostics: {
          context_pack_persisted: true,
          context_pack_uri: expect.stringMatching(/^file:/),
          retrieval: { experiences: 0, skills: 0 },
        },
      });
      const files = await fs.readdir(root);
      expect(files).toEqual([`${result.context_pack_ref}.json`]);
      const persisted = JSON.parse(await fs.readFile(path.join(root, files[0]!), 'utf-8'));
      expect(persisted).toMatchObject({
        context_pack_id: result.context_pack_ref,
        task_id: 'task_evidence',
        agent_id: 'implementer',
        memory_buffer_ref: 'implementer:1',
        retrieval: { experiences: [], skills: [] },
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('preserves the original C instruction when B delegates a narrower subtask', async () => {
    const driver = new CapturingDriver('succeeded');
    const { facade } = createFacade(
      driver,
      new InMemoryBufferRepository(),
      delegatedInstructionLlm('Only inspect the target.'),
    );

    await facade.runAgent(request('task_original_instruction', 'proposer_a'));

    const prompt = JSON.parse(driver.prompts[0]!.prompt) as {
      task_instruction: string;
      experiences: Array<{ id: string; content: string }>;
    };
    expect(prompt.task_instruction).toBe('Execute through B runtime.');
    expect(prompt.experiences).toContainEqual({
      id: 'b_delegation',
      description: 'B runtime delegation guidance',
      content: 'Only inspect the target.',
    });
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

  it('retries one artifact-free retryable transport failure', async () => {
    const driver = new RetryableOnceDriver();
    const { facade } = createFacade(driver);

    const result = await facade.runAgent(request('task_retry', 'proposer_a'));

    expect(driver.prompts).toHaveLength(2);
    expect(result).toMatchObject({
      status: 'completed',
      diagnostics: { driver_attempts: 2 },
    });
  });

  it('does not retry an artifact-free retryable business failure', async () => {
    const driver = new RetryableOnceDriver('RETRYABLE_VALIDATION');
    const { facade } = createFacade(driver);

    const result = await facade.runAgent(request('task_no_business_retry', 'proposer_a'));

    expect(driver.prompts).toHaveLength(1);
    expect(result).toMatchObject({ status: 'failed', diagnostics: { driver_attempts: 1 } });
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

  it('keeps concurrent role invocations associated with their own task and run', async () => {
    const driver = new ConcurrentDriver();
    const { facade } = createFacade(driver);

    await Promise.all([
      facade.runAgent(request('task_parallel_a', 'proposer_a')),
      facade.runAgent(request('task_parallel_b', 'proposer_b')),
    ]);

    expect(driver.maxActive).toBe(2);
    expect(
      driver.prompts
        .map((prompt) => ({ task_id: prompt.task_id, run_id: prompt.run_id }))
        .sort((left, right) => left.task_id.localeCompare(right.task_id)),
    ).toEqual([
      { task_id: 'task_parallel_a', run_id: 'run_task_parallel_a' },
      { task_id: 'task_parallel_b', run_id: 'run_task_parallel_b' },
    ]);
  });

  it('serializes different roles that target the same workspace', async () => {
    const driver = new ConcurrentDriver();
    const { facade } = createFacade(driver);
    const workspace = '/tmp/newide-shared-workspace';

    await Promise.all([
      facade.runAgent(request('task_shared_a', 'proposer', workspace)),
      facade.runAgent(request('task_shared_b', 'reviewer', workspace)),
    ]);

    expect(driver.maxActive).toBe(1);
  });

  it('runs the same role concurrently in different workspace scopes', async () => {
    const driver = new ConcurrentDriver();
    const { facade } = createFacade(driver);

    const [first, second] = await Promise.all([
      facade.runAgent(request('task_workspace_a', 'proposer', '/tmp/newide-workspace-a')),
      facade.runAgent(request('task_workspace_b', 'proposer', '/tmp/newide-workspace-b')),
    ]);

    expect(driver.maxActive).toBe(2);
    expect(first.memory_buffer_ref).not.toBe(second.memory_buffer_ref);
    expect(driver.prompts.map((prompt) => prompt.workspace_path).sort()).toEqual([
      '/tmp/newide-workspace-a',
      '/tmp/newide-workspace-b',
    ]);
  });

  it('returns a failed result when B completes without invoking the driver', async () => {
    const driver = new CapturingDriver('succeeded');
    const { facade } = createFacade(driver, new InMemoryBufferRepository(), noDriverLlm());

    const result = await facade.runAgent(request('task_no_driver', 'reviewer'));

    expect(driver.prompts).toHaveLength(0);
    expect(result).toMatchObject({
      role_id: 'reviewer',
      status: 'failed',
      artifact_refs: [],
      diagnostics: {
        dispatch_status: 'no_driver_invocation',
        driver_error_code: 'B_NO_DRIVER_INVOCATION',
      },
    });
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
    await expect(buffer.getBufferMeta('proposer_a')).rejects.toThrow('Buffer store not found');
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
    expect(interrupt).toHaveBeenCalledWith('Cancel B runtime execution', 'run_task_cancel');
    expect((await buffer.getBufferMeta('proposer_a')).total_processed).toBe(0);
  });

  it('continues a queued role execution after the active execution is aborted', async () => {
    const controller = new AbortController();
    const driver = new AbortOnceDriver();
    const { facade } = createFacade(
      driver,
      new InMemoryBufferRepository(),
      invokeDriverLlm(),
      new FailOnceOnReloadRepository(),
    );

    const cancelled = facade.runAgent(request('task_cancel_once', 'proposer_a'), {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(driver.prompts).toHaveLength(1));
    const queued = facade.runAgent(request('task_after_cancel', 'proposer_a'));
    controller.abort(new Error('Cancel first role execution'));

    await expect(cancelled).rejects.toThrow('Cancel first role execution');
    await expect(queued).resolves.toMatchObject({
      status: 'completed',
    });
    expect(driver.prompts).toHaveLength(2);
  });

  it('stops while B waits for the post-driver LLM response', async () => {
    const controller = new AbortController();
    const llm = new BlockingPostDriverLlm();
    const { facade } = createFacade(
      new CapturingDriver('succeeded'),
      new InMemoryBufferRepository(),
      llm,
    );

    const running = facade.runAgent(request('cancel_post_driver_llm', 'proposer_a'), {
      signal: controller.signal,
    });
    await llm.postDriverCallStarted;
    controller.abort(new Error('Cancel post-driver LLM'));

    await expect(running).rejects.toThrow('Cancel post-driver LLM');
  });

  it('invokes the driver only once when B requests duplicate calls', async () => {
    const driver = new CapturingDriver('succeeded');
    const { facade } = createFacade(driver, new InMemoryBufferRepository(), twoDriverCallsLlm());

    const result = await facade.runAgent(request('duplicate_driver', 'proposer_a'));

    expect(result.status).toBe('completed');
    expect(driver.prompts).toHaveLength(1);
  });

  it('rejects an aborted queued execution without waiting for the active role execution', async () => {
    const activeController = new AbortController();
    const queuedController = new AbortController();
    const driver = new MockDriver();
    driver.sendPrompt = vi.fn(() => new Promise<DriverRunResult>(() => undefined));
    const { facade } = createFacade(driver);

    const active = facade.runAgent(request('active_role_task', 'proposer_a'), {
      signal: activeController.signal,
    });
    await vi.waitFor(() => expect(driver.sendPrompt).toHaveBeenCalledTimes(1));
    const queued = facade.runAgent(request('queued_role_task', 'proposer_a'), {
      signal: queuedController.signal,
    });
    queuedController.abort(new Error('Cancel queued task'));

    await expect(queued).rejects.toThrow('Cancel queued task');
    activeController.abort(new Error('Clean up active task'));
    await expect(active).rejects.toThrow('Clean up active task');
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
    expect(await buffer.getBufferMeta('proposer_a')).toMatchObject({
      pending_count: 1,
      total_processed: 0,
    });
  });
});

function createFacade(
  driver: DriverRuntimeHandle,
  buffer: InMemoryBufferRepository = new InMemoryBufferRepository(),
  llm: ToolCallingClient = invokeDriverLlm(),
  repository: InMemoryRepository = new InMemoryRepository(),
) {
  return {
    facade: new DriverRuntimeAgentExecutionFacade({
      driver,
      repository,
      bufferRepository: buffer,
      llm,
    }),
    buffer,
  };
}

class FailOnceOnReloadRepository extends InMemoryRepository {
  private listCalls = 0;

  override async listAgentIds(): Promise<string[]> {
    this.listCalls += 1;
    if (this.listCalls === 2) throw new Error('Transient repository reload failure');
    return super.listAgentIds();
  }
}

function invokeDriverLlm(): ToolCallingClient {
  let toolCallSequence = 0;
  return {
    async completeWithTools(input) {
      const lastMessage = input.messages.at(-1);
      if (lastMessage?.role === 'tool') {
        return { content: 'Task completed. [done]', tool_calls: undefined };
      }
      const userMessage = [...input.messages].reverse().find((message) => message.role === 'user');
      toolCallSequence += 1;
      return {
        content: null,
        tool_calls: [
          {
            id: `tool_call_${String(toolCallSequence)}`,
            type: 'function',
            function: {
              name: 'invoke_driver',
              arguments: JSON.stringify({
                instruction: userMessage?.content?.replace(/^Task:\s*/, '') ?? 'Execute task.',
              }),
            },
          },
        ],
      };
    },
  };
}

function noDriverLlm(): ToolCallingClient {
  return {
    async completeWithTools() {
      return { content: 'Task completed without delegation. [done]', tool_calls: undefined };
    },
  };
}

function delegatedInstructionLlm(instruction: string): ToolCallingClient {
  let calls = 0;
  return {
    async completeWithTools() {
      calls += 1;
      if (calls > 1) return { content: 'Task completed. [done]', tool_calls: undefined };
      return {
        content: null,
        tool_calls: [
          {
            id: 'delegated_instruction',
            type: 'function',
            function: {
              name: 'invoke_driver',
              arguments: JSON.stringify({ instruction }),
            },
          },
        ],
      };
    },
  };
}

class BlockingPostDriverLlm implements ToolCallingClient {
  private calls = 0;
  private postDriverCallStartedResolve!: () => void;
  readonly postDriverCallStarted = new Promise<void>((resolve) => {
    this.postDriverCallStartedResolve = resolve;
  });

  async completeWithTools() {
    this.calls += 1;
    if (this.calls === 1) {
      return driverToolCalls('post_driver_call');
    }
    this.postDriverCallStartedResolve();
    return new Promise<never>(() => undefined);
  }
}

function twoDriverCallsLlm(): ToolCallingClient {
  let calls = 0;
  return {
    async completeWithTools() {
      calls += 1;
      if (calls > 1) return { content: 'Task completed. [done]', tool_calls: undefined };
      return driverToolCalls('first_driver_call', 'second_driver_call');
    },
  };
}

function driverToolCalls(...ids: string[]) {
  return {
    content: null,
    tool_calls: ids.map((id) => ({
      id,
      type: 'function' as const,
      function: {
        name: 'invoke_driver',
        arguments: JSON.stringify({ instruction: `Execute ${id}.` }),
      },
    })),
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

function request(taskId: string, roleId: string, workspacePath?: string) {
  return {
    task_id: taskId,
    run_id: `run_${taskId}`,
    role_id: roleId,
    instruction: 'Execute through B runtime.',
    input_artifact_refs: [],
    context_policy: 'default',
    ...(workspacePath ? { workspace_path: workspacePath } : {}),
    session_id: 'session_existing',
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
    return driverResult(this, this.status, input.session_id);
  }

  async interrupt(_reason: string): Promise<void> {}

  async collectTranscript(): Promise<ArtifactRef> {
    return createArtifact('artifact_transcript_001', 'transcript');
  }
}

class AbortOnceDriver extends CapturingDriver {
  constructor() {
    super('succeeded');
  }

  override async sendPrompt(input: DriverPrompt): Promise<DriverRunResult> {
    this.prompts.push(input);
    if (this.prompts.length === 1) {
      return new Promise<DriverRunResult>(() => undefined);
    }
    return driverResult(this, 'succeeded', input.session_id);
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
    return driverResult(this, 'succeeded', input.session_id);
  }
}

class RetryableOnceDriver extends CapturingDriver {
  constructor(private readonly errorCode = 'EXTERNAL_DRIVER_TRANSPORT_ERROR') {
    super('succeeded');
  }

  override async sendPrompt(input: DriverPrompt): Promise<DriverRunResult> {
    this.prompts.push(input);
    if (this.prompts.length > 1) return driverResult(this, 'succeeded', input.session_id);
    return {
      ...driverResult(this, 'failed', input.session_id),
      error: {
        code: this.errorCode,
        message: 'Transient transport failure.',
        retryable: true,
      },
    };
  }
}

function driverResult(
  driver: DriverRuntimeHandle,
  status: DriverRunResult['status'],
  sessionId?: string,
): DriverRunResult {
  return {
    driver_run_result_id: 'driver_result_001',
    session_id: sessionId ?? driver.session_id,
    status,
    response: status === 'succeeded' ? 'Agent completed the requested change.' : '',
    artifacts: status === 'succeeded' ? [createArtifact('artifact_output_001')] : [],
    transcript_ref: createArtifact('artifact_transcript_001', 'transcript'),
    tool_events: [
      {
        tool_event_id: 'tool_event_001',
        tool_name: 'edit',
        status: 'completed',
        summary: 'Updated the requested file.',
        created_at: '2026-07-07T00:00:00.000Z',
        schema_version: SCHEMA_VERSION,
      },
    ],
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
