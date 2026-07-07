/**
 * AgentExecutionFacade 端口
 *
 * B 方向负责 role / persona / context / lifetime / memory，再通过 A 方向 driver 执行模型调用。
 * C / Council 只调用这个门面，不直接依赖底层 DriverRuntimeHandle。
 */
import type {
  ArtifactId,
  ContextPackId,
  DriverRunResultId,
  RoleId,
  RunId,
  SchemaVersion,
  TaskId,
  Timestamp,
} from '../../core';

export const AGENT_EXECUTION_STATUSES = [
  'completed',
  'failed',
  'cancelled',
  'interrupted',
] as const;

export type AgentExecutionStatus = (typeof AGENT_EXECUTION_STATUSES)[number];
export type AgentRunId = string;
export type AgentExecutionDiagnostics = Record<string, unknown>;

export interface AgentExecutionRequest {
  task_id: TaskId;
  run_id: RunId;
  role_id: RoleId;
  instruction: string;
  input_artifact_refs: ArtifactId[];
  context_policy: string;
  schema_version: SchemaVersion;
}

export interface AgentExecutionResult {
  agent_run_id: AgentRunId;
  role_id: RoleId;
  context_pack_ref: ContextPackId;
  driver_run_result_id: DriverRunResultId;
  artifact_refs: ArtifactId[];
  transcript_ref: ArtifactId;
  diagnostics: AgentExecutionDiagnostics;
  status: AgentExecutionStatus;
  memory_buffer_ref?: string;
  created_at: Timestamp;
  schema_version: SchemaVersion;
}

export interface AgentExecutionFacade {
  runAgent(input: AgentExecutionRequest): Promise<AgentExecutionResult>;
}
