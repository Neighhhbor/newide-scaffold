import { SCHEMA_VERSION, createId, nowTimestamp } from '../../core';
import type { DriverRunStatus } from '../../driver';
import type { AgentManager } from '../runtime/agent-manager';
import type {
  AgentExecutionFacade,
  AgentExecutionOptions,
  AgentExecutionRequest,
  AgentExecutionResult,
  AgentExecutionStatus,
} from '../ports/agent-execution-facade';

export interface DriverRuntimeAgentExecutionFacadeOptions {
  manager: AgentManager;
  source_driver: string;
}

export class DriverRuntimeAgentExecutionFacade implements AgentExecutionFacade {
  constructor(private readonly options: DriverRuntimeAgentExecutionFacadeOptions) {}

  async runAgent(
    input: AgentExecutionRequest,
    options?: AgentExecutionOptions,
  ): Promise<AgentExecutionResult> {
    const cycle = await this.options.manager.runRole(
      input.role_id,
      {
        spec: input.instruction,
        task_id: input.task_id,
        run_id: input.run_id,
        call_id: createId('call'),
        source_driver: this.options.source_driver,
      },
      { ...(options?.signal ? { signal: options.signal } : {}), run_id: input.run_id },
    );
    const execution = cycle.driver_execution;
    if (!execution)
      throw new Error(`Agent role ${input.role_id} completed without a driver execution result`);
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
