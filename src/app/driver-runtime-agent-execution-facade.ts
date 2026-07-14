import { AsyncLocalStorage } from 'node:async_hooks';
import { SCHEMA_VERSION, createId, nowTimestamp, type ArtifactRef } from '../core';
import {
  AgentManager,
  InvokeDriverTool,
  type BufferRepository,
  type DispatchTaskResult,
  type DriverTask,
  type MemoryRepository,
  type ToolCallingClient,
} from '../memory';
import type {
  AgentExecutionFacade,
  AgentExecutionOptions,
  AgentExecutionRequest,
  AgentExecutionResult,
  AgentExecutionStatus,
} from '../protocol/agent-execution';
import type { DriverRunResult, DriverRunStatus, DriverRuntimeHandle } from '../driver/contract';
import { createDriverRuntimeInvoker } from '../driver/driver-runtime-invoker';

export interface DriverRuntimeAgentExecutionFacadeOptions {
  driver: DriverRuntimeHandle;
  repository: MemoryRepository;
  bufferRepository: BufferRepository;
  llm: ToolCallingClient;
}

interface InvocationContext {
  task_id: string;
  run_id: string;
  instruction: string;
  workspace_path?: string;
  session_id?: string;
  signal?: AbortSignal;
  execution?: DriverRunResult;
  driver_attempts: number;
  abortObserved: boolean;
}

const AGENT_SYSTEM_PROMPT = [
  'You execute one role in a Coordinator-managed workflow.',
  'You may call query_memory before delegating when prior context is useful.',
  'Call invoke_driver exactly once with the complete concrete task.',
  'After invoke_driver returns, do not call more tools. Summarize the result and include "[done]".',
].join('\n');

export class DriverRuntimeAgentExecutionFacade implements AgentExecutionFacade {
  private readonly manager: Promise<AgentManager>;
  private readonly roleReady = new Map<string, Promise<AgentManager>>();
  private readonly invalidatedRoles = new Set<string>();
  private readonly roleQueues = new Map<string, Promise<void>>();
  private readonly invocationContext = new AsyncLocalStorage<InvocationContext>();
  private readonly invokeDriverRuntime: ReturnType<typeof createDriverRuntimeInvoker>;

  constructor(private readonly options: DriverRuntimeAgentExecutionFacadeOptions) {
    this.invokeDriverRuntime = createDriverRuntimeInvoker(options.driver);
    this.manager = this.createManager();
  }

  private createManager(): Promise<AgentManager> {
    return AgentManager.create(this.options.repository, this.options.bufferRepository, {
      tools: {
        llm: {
          completeWithTools: (input) => this.completeWithTools(input),
        },
        tools: [new InvokeDriverTool((task) => this.invokeDriver(task))],
        systemPrompt: AGENT_SYSTEM_PROMPT,
        maxToolCalls: 4,
      },
    });
  }

  async runAgent(
    input: AgentExecutionRequest,
    options?: AgentExecutionOptions,
  ): Promise<AgentExecutionResult> {
    throwIfAborted(options?.signal);
    return this.enqueue(
      input.role_id,
      async () => {
        throwIfAborted(options?.signal);
        const manager = await this.ensureRole(input.role_id);
        return this.execute(manager, input, options);
      },
      options?.signal,
    );
  }

  private async execute(
    manager: AgentManager,
    input: AgentExecutionRequest,
    options?: AgentExecutionOptions,
  ): Promise<AgentExecutionResult> {
    const invocation: InvocationContext = {
      task_id: input.task_id,
      run_id: input.run_id,
      instruction: input.instruction,
      ...(input.workspace_path ? { workspace_path: input.workspace_path } : {}),
      ...(input.session_id ? { session_id: input.session_id } : {}),
      driver_attempts: 0,
      abortObserved: false,
      ...(options?.signal ? { signal: options.signal } : {}),
    };
    const dispatched = await this.invocationContext.run(invocation, () =>
      manager.dispatchTask(input.role_id, {
        spec: input.instruction,
        task_id: input.task_id,
        call_id: createId('call'),
        source_driver: this.options.driver.driver_id,
      }),
    );

    if (invocation.abortObserved || (invocation.signal?.aborted && !invocation.execution)) {
      await this.recoverRole(input.role_id);
      throwIfAborted(invocation.signal);
    }
    return this.buildResult(input, dispatched, invocation.execution, invocation.driver_attempts);
  }

  private async ensureRole(role_id: string): Promise<AgentManager> {
    const existing = this.roleReady.get(role_id);
    if (existing) return existing;

    const manager = this.invalidatedRoles.has(role_id) ? this.createManager() : this.manager;
    const creating = manager
      .then(async (manager) => {
        if (!manager.getAgent(role_id)) {
          await manager.createAgent({ role_id, name: role_id, tags: [] });
        }
        this.invalidatedRoles.delete(role_id);
        return manager;
      })
      .catch((error: unknown) => {
        this.roleReady.delete(role_id);
        throw error;
      });
    this.roleReady.set(role_id, creating);
    return creating;
  }

  private async recoverRole(role_id: string): Promise<void> {
    this.roleReady.delete(role_id);
    this.invalidatedRoles.add(role_id);
    await this.ensureRole(role_id).catch(() => undefined);
  }

  private async completeWithTools(
    input: Parameters<ToolCallingClient['completeWithTools']>[0],
  ): ReturnType<ToolCallingClient['completeWithTools']> {
    const invocation = this.invocationContext.getStore();
    if (!invocation) {
      return this.options.llm.completeWithTools(input);
    }
    try {
      throwIfAborted(invocation.signal);
      return await withAbort(this.options.llm.completeWithTools(input), invocation.signal);
    } catch (error) {
      if (invocation.signal?.aborted) invocation.abortObserved = true;
      throw error;
    }
  }

  private async invokeDriver(task: DriverTask) {
    const invocation = this.invocationContext.getStore();
    if (!invocation) {
      throw new Error('B invoke_driver was called outside an AgentExecutionFacade invocation');
    }
    if (invocation.execution) {
      throw new Error('A C role execution can invoke the driver only once');
    }
    throwIfAborted(invocation.signal);
    try {
      const invoke = () => {
        invocation.driver_attempts += 1;
        return this.invokeDriverRuntime(
          {
            task_id: invocation.task_id,
            run_id: invocation.run_id,
            ...(invocation.workspace_path ? { workspace_path: invocation.workspace_path } : {}),
            ...(invocation.session_id ? { session_id: invocation.session_id } : {}),
            call_id: createId('call'),
            source_driver: this.options.driver.driver_id,
            driver_context: {
              task_instruction: invocation.instruction,
              skills: toMemoryItems('skill', task.context?.skills),
              experiences: [
                ...toMemoryItems('experience', task.context?.experiences),
                ...delegationContext(invocation.instruction, task.instruction),
              ],
            },
          },
          invocation.signal ? { signal: invocation.signal } : undefined,
        );
      };
      let result = await invoke();
      if (isArtifactFreeRetryableFailure(result.execution)) {
        throwIfAborted(invocation.signal);
        result = await invoke();
      }
      invocation.execution = result.execution;
      return result.report;
    } catch (error) {
      if (invocation.signal?.aborted) invocation.abortObserved = true;
      throw error;
    }
  }

  private buildResult(
    input: AgentExecutionRequest,
    dispatched: DispatchTaskResult,
    execution: DriverRunResult | undefined,
    driverAttempts: number,
  ): AgentExecutionResult {
    if (!execution) {
      return this.buildNoExecutionResult(input, dispatched);
    }

    const dispatchFailed = dispatched.status !== 'completed';
    const dispatchError = dispatchFailed
      ? {
          code: `B_${dispatched.status.toUpperCase()}`,
          message: dispatched.cycle.buffer_snapshot.driver_return.summary,
          retryable: dispatched.status === 'blocked',
        }
      : undefined;

    return {
      agent_run_id: createId('agent_run'),
      role_id: input.role_id,
      context_pack_ref: createId('context_pack'),
      driver_run_result_id: execution.driver_run_result_id,
      artifact_refs: [...execution.artifacts],
      transcript_ref: execution.transcript_ref,
      session_id: execution.session_id,
      response: execution.response ?? '',
      tool_events: [...execution.tool_events],
      diagnostics: {
        ...execution.diagnostics,
        driver_status: execution.status,
        driver_attempts: driverAttempts,
        dispatch_status: dispatched.status,
        context_policy: input.context_policy,
        input_artifact_refs: [...input.input_artifact_refs],
        buffer_seq: dispatched.cycle.buffer_seq,
        retrieval: {
          experiences: dispatched.cycle.retrieval.experiences.length,
          skills: dispatched.cycle.retrieval.skills.length,
        },
        promotion: dispatched.cycle.promotion.check,
        context_pack_persisted: false,
        ...(execution.error
          ? { driver_error: { ...execution.error }, driver_error_code: execution.error.code }
          : dispatchError
            ? { driver_error: dispatchError, driver_error_code: dispatchError.code }
            : {}),
      },
      status: mapStatus(dispatched.status, execution.status),
      memory_buffer_ref: `${input.role_id}:${dispatched.cycle.buffer_seq}`,
      created_at: nowTimestamp(),
      schema_version: SCHEMA_VERSION,
    };
  }

  private buildNoExecutionResult(
    input: AgentExecutionRequest,
    dispatched: DispatchTaskResult,
  ): AgentExecutionResult {
    const created_at = nowTimestamp();
    const errorCode = `B_${dispatched.status.toUpperCase()}`;
    const errorMessage = dispatched.cycle.buffer_snapshot.driver_return.summary;
    const transcript: ArtifactRef = {
      artifact_id: createId('artifact'),
      type: 'transcript',
      uri: `artifact://transcript/${encodeURIComponent(input.task_id)}/${encodeURIComponent(input.role_id)}`,
      producer_id: this.options.driver.driver_id,
      task_id: input.task_id,
      metadata: { dispatch_status: dispatched.status, error: errorMessage },
      created_at,
      schema_version: SCHEMA_VERSION,
    };

    return {
      agent_run_id: createId('agent_run'),
      role_id: input.role_id,
      context_pack_ref: createId('context_pack'),
      driver_run_result_id: createId('driver_result'),
      artifact_refs: [],
      transcript_ref: transcript,
      session_id: this.options.driver.session_id,
      response: '',
      tool_events: [],
      diagnostics: {
        driver_id: this.options.driver.driver_id,
        driver_status: 'failed',
        dispatch_status: dispatched.status,
        driver_error_code: errorCode,
        driver_error: {
          code: errorCode,
          message: errorMessage,
          retryable: dispatched.status === 'blocked',
        },
        context_policy: input.context_policy,
        input_artifact_refs: [...input.input_artifact_refs],
        buffer_seq: dispatched.cycle.buffer_seq,
        context_pack_persisted: false,
      },
      status: dispatched.status === 'cancelled' ? 'cancelled' : 'failed',
      memory_buffer_ref: `${input.role_id}:${dispatched.cycle.buffer_seq}`,
      created_at,
      schema_version: SCHEMA_VERSION,
    };
  }

  private enqueue<T>(
    role_id: string,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const previous = this.roleQueues.get(role_id) ?? Promise.resolve();
    let started = false;
    const running = previous.then(() => {
      started = true;
      return operation();
    });
    this.roleQueues.set(
      role_id,
      running.then(
        () => undefined,
        () => undefined,
      ),
    );
    return rejectWhileQueued(running, signal, () => started);
  }
}

function mapStatus(
  dispatchStatus: DispatchTaskResult['status'],
  driverStatus: DriverRunStatus,
): AgentExecutionStatus {
  if (dispatchStatus === 'cancelled') return 'cancelled';
  if (dispatchStatus !== 'completed') return 'failed';
  return (
    {
      succeeded: 'completed',
      failed: 'failed',
      cancelled: 'cancelled',
      interrupted: 'interrupted',
    } as const
  )[driverStatus];
}

function toMemoryItems(prefix: string, values: string[] | undefined) {
  return (values ?? []).map((content, index) => ({
    id: `${prefix}_${String(index + 1)}`,
    description: `B runtime ${prefix} context`,
    content,
  }));
}

function delegationContext(original: string, delegated: string) {
  if (delegated.trim() === original.trim()) return [];
  return [{ id: 'b_delegation', description: 'B runtime delegation guidance', content: delegated }];
}

function isArtifactFreeRetryableFailure(execution: DriverRunResult): boolean {
  return (
    execution.status === 'failed' &&
    execution.error?.code === 'EXTERNAL_DRIVER_TRANSPORT_ERROR' &&
    execution.error?.retryable === true &&
    execution.artifacts.length === 0
  );
}

function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortReason(signal));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

function rejectWhileQueued<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  hasStarted: () => boolean,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted && !hasStarted()) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      if (!hasStarted()) reject(abortReason(signal));
    };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw abortReason(signal);
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new DOMException(
    typeof signal.reason === 'string' ? signal.reason : 'The operation was aborted',
    'AbortError',
  );
}
