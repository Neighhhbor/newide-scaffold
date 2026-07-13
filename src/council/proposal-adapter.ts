import { SCHEMA_VERSION, createId, nowTimestamp, type RunId, type TaskId } from '../core';
import type { DriverRunResult } from '../driver';
import type { GateResult } from '../gate';
import type { Proposal } from './contract';

export interface BuildCouncilProposalFromDriverResultInput {
  run_id: RunId;
  task_id: TaskId;
  driver_result: DriverRunResult;
  gate_results: GateResult[];
}

/**
 * 将 driver 产物转换为 Council 可评审的最小 Proposal。
 * 这里只做数据适配，不做 proposal 质量判断或 LLM 提取。
 */
export function buildCouncilProposalFromDriverResult(
  input: BuildCouncilProposalFromDriverResultInput,
): Proposal {
  return {
    proposal_id: createId('proposal'),
    run_id: input.run_id,
    task_id: input.task_id,
    agent_id: input.driver_result.diagnostics.driver_id,
    artifact_refs: input.driver_result.artifacts.map((artifact) => artifact.artifact_id),
    summary: 'Driver output artifacts for council review',
    claims: [],
    affected_paths: [],
    assumptions: [],
    known_risks: [],
    completion_evidence: input.gate_results.map((gate) => gate.gate_result_id),
    created_at: nowTimestamp(),
    schema_version: SCHEMA_VERSION,
  };
}
