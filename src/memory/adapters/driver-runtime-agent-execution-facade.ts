/**
 * DriverRuntimeAgentExecutionFacade
 *
 * B 方向到 A 方向 DriverRuntimeHandle 的最小 adapter。
 * 它不创建 C 的 task/run，也不执行 memory-cycle；只把一次 agent 执行请求转换为 driver 调用结果。
 */
import { SCHEMA_VERSION, createId, nowTimestamp, type ContextPackRef } from '../../core';
import type {
  DriverPrompt,
  DriverRunResult,
  DriverRuntimeHandle,
  DriverRunStatus,
} from '../../driver';
import type {
  AgentExecutionFacade,
  AgentExecutionRequest,
  AgentExecutionResult,
  AgentExecutionStatus,
} from '../ports/agent-execution-facade';

export interface DriverRuntimeAgentExecutionFacadeOptions {
  driver: DriverRuntimeHandle;
  buildContextPackRef?: (input: AgentExecutionRequest) => ContextPackRef;
}

export class DriverRuntimeAgentExecutionFacade implements AgentExecutionFacade {
  private readonly driver: DriverRuntimeHandle;
  private readonly buildContextPackRef: (input: AgentExecutionRequest) => ContextPackRef;

  constructor(options: DriverRuntimeAgentExecutionFacadeOptions) {
    this.driver = options.driver;
    this.buildContextPackRef = options.buildContextPackRef ?? defaultContextPackRef;
  }

  async runAgent(input: AgentExecutionRequest): Promise<AgentExecutionResult> {
    const contextPackRef = this.buildContextPackRef(input);
    const driverPrompt: DriverPrompt = {
      task_id: input.task_id,
      run_id: input.run_id,
      prompt: input.instruction,
      context_pack_ref: contextPackRef,
      created_at: nowTimestamp(),
      schema_version: input.schema_version,
    };
    const driverResult = await this.driver.sendPrompt(driverPrompt);

    return {
      agent_run_id: createId('agent_run'),
      role_id: input.role_id,
      context_pack_ref: contextPackRef.context_pack_id,
      driver_run_result_id: driverResult.driver_run_result_id,
      artifact_refs: [...driverResult.artifacts],
      transcript_ref: driverResult.transcript_ref,
      diagnostics: buildDiagnostics(input, driverResult),
      status: mapDriverStatus(driverResult.status),
      created_at: nowTimestamp(),
      schema_version: SCHEMA_VERSION,
    };
  }
}

function defaultContextPackRef(input: AgentExecutionRequest): ContextPackRef {
  return {
    context_pack_id: createId('context_pack'),
    uri: `context://agent-execution/${input.task_id}/${input.role_id}`,
    task_id: input.task_id,
    schema_version: input.schema_version,
  };
}

function mapDriverStatus(status: DriverRunStatus): AgentExecutionStatus {
  switch (status) {
    case 'succeeded':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'interrupted':
      return 'interrupted';
  }
}

function buildDiagnostics(
  input: AgentExecutionRequest,
  driverResult: DriverRunResult,
): Record<string, unknown> {
  return {
    ...driverResult.diagnostics,
    driver_status: driverResult.status,
    context_policy: input.context_policy,
    input_artifact_refs: [...input.input_artifact_refs],
    ...(driverResult.error ? { driver_error_code: driverResult.error.code } : {}),
  };
}
