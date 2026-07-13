import { SCHEMA_VERSION, createId, nowTimestamp } from '../core';
import {
  AgentManager,
  defaultMvpAgentRunDeps,
  type AgentRunDeps,
  type BufferRepository,
  type DriverInvokeInput,
  type MemoryRepository,
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
}

interface InvocationContext {
  run_id: string;
  signal?: AbortSignal;
  execution?: DriverRunResult;
}

export class DriverRuntimeAgentExecutionFacade implements AgentExecutionFacade {
  private readonly roleManagers = new Map<string, Promise<AgentManager>>();
  private readonly roleQueues = new Map<string, Promise<void>>();
  private readonly invocations = new Map<string, InvocationContext>();
  private readonly invokeDriverRuntime: ReturnType<typeof createDriverRuntimeInvoker>;

  constructor(private readonly options: DriverRuntimeAgentExecutionFacadeOptions) {
    this.invokeDriverRuntime = createDriverRuntimeInvoker(options.driver);
  }

  async runAgent(
    input: AgentExecutionRequest,
    options?: AgentExecutionOptions,
  ): Promise<AgentExecutionResult> {
    const manager = await this.ensureRoleManager(input.role_id);
    return this.enqueue(input.role_id, async () => {
      throwIfAborted(options?.signal);
      return this.execute(manager, input, options);
    });
  }

  private async execute(
    manager: AgentManager,
    input: AgentExecutionRequest,
    options?: AgentExecutionOptions,
  ): Promise<AgentExecutionResult> {
    const call_id = createId('call');
    const invocation: InvocationContext = {
      run_id: input.run_id,
      ...(options?.signal ? { signal: options.signal } : {}),
    };
    this.invocations.set(call_id, invocation);

    try {
      const submitted = await manager.submitTask({
        spec: input.instruction,
        task_id: input.task_id,
        call_id,
        source_driver: this.options.driver.driver_id,
      });

      const execution = invocation.execution;
      if (!execution) {
        throw new Error(`Agent role ${input.role_id} completed without a driver execution result`);
      }
      const cycle = submitted.cycle;
      return {
        agent_run_id: createId('agent_run'),
        role_id: input.role_id,
        context_pack_ref: createId('context_pack'),
        driver_run_result_id: execution.driver_run_result_id,
        artifact_refs: [...execution.artifacts],
        transcript_ref: execution.transcript_ref,
        diagnostics: {
          ...execution.diagnostics,
          driver_status: execution.status,
          context_policy: input.context_policy,
          input_artifact_refs: [...input.input_artifact_refs],
          buffer_seq: cycle.buffer_seq,
          retrieval: {
            experiences: cycle.retrieval.experiences.length,
            skills: cycle.retrieval.skills.length,
          },
          promotion: cycle.promotion.check,
          context_pack_persisted: false,
          ...(execution.error
            ? { driver_error: { ...execution.error }, driver_error_code: execution.error.code }
            : {}),
        },
        status: mapStatus(execution.status),
        memory_buffer_ref: `${input.role_id}:${cycle.buffer_seq}`,
        created_at: nowTimestamp(),
        schema_version: SCHEMA_VERSION,
      };
    } finally {
      this.invocations.delete(call_id);
    }
  }

  private ensureRoleManager(role_id: string): Promise<AgentManager> {
    const existing = this.roleManagers.get(role_id);
    if (existing) return existing;

    const creating = this.createRoleManager(role_id).catch((error: unknown) => {
      this.roleManagers.delete(role_id);
      throw error;
    });
    this.roleManagers.set(role_id, creating);
    return creating;
  }

  private async createRoleManager(role_id: string): Promise<AgentManager> {
    const deps: AgentRunDeps = {
      ...defaultMvpAgentRunDeps,
      planTaskInstruction: async (task) => task.spec,
      invokeDriver: (input) => this.invokeDriver(input),
    };
    const manager = AgentManager.create(this.options.repository, this.options.bufferRepository, {
      deps,
    });
    await manager.createAgent({ role_id, name: role_id });
    return manager;
  }

  private async invokeDriver(input: DriverInvokeInput) {
    const invocation = this.invocations.get(input.call_id);
    if (!invocation) {
      throw new Error(`Driver invocation context not found: ${input.call_id}`);
    }
    const result = await this.invokeDriverRuntime(
      { ...input, run_id: invocation.run_id },
      invocation.signal ? { signal: invocation.signal } : undefined,
    );
    invocation.execution = result.execution;
    return result.report;
  }

  private enqueue<T>(role_id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.roleQueues.get(role_id) ?? Promise.resolve();
    const running = previous.then(operation);
    this.roleQueues.set(
      role_id,
      running.then(
        () => undefined,
        () => undefined,
      ),
    );
    return running;
  }
}

function mapStatus(status: DriverRunStatus): AgentExecutionStatus {
  return (
    {
      succeeded: 'completed',
      failed: 'failed',
      cancelled: 'cancelled',
      interrupted: 'interrupted',
    } as const
  )[status];
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException(
    typeof signal.reason === 'string' ? signal.reason : 'The operation was aborted',
    'AbortError',
  );
}
