import type { CheckpointId, RunId, TaskId } from '../core';
import type { TelemetryEmission } from './telemetry-sink';

export interface SweEvoEvaluationTelemetryInput {
  instance_id: string;
  instance_seq: number;
  resolved: boolean;
  fix_rate?: number;
  f2p?: Record<string, unknown>;
  applied: boolean;
  p2p_regression: boolean;
  memory_ablation?: 'B0' | 'B1' | 'B2' | 'B3';
  task_id?: TaskId;
  run_id?: RunId;
}

export interface CooperBenchEvaluationTelemetryInput {
  case_id: string;
  both_passed: boolean;
  coordination_deficit: number;
  failure_taxonomy: string[];
  task_id?: TaskId;
  run_id?: RunId;
}

export interface ProxyUsageTelemetryInput {
  case_id: string;
  input_tokens: number;
  output_tokens: number;
  model?: string;
  task_id?: TaskId;
  run_id?: RunId;
}

export interface AgentCrashTelemetryInput {
  task_id: TaskId;
  run_id?: RunId;
  kill_at: string;
  progress_pct: number;
  tool_call_count: number;
  had_checkpoint: boolean;
  kill_at_status: string;
  checkpoint_id_at_kill?: CheckpointId;
}

export interface ColdRestartTelemetryInput {
  task_id: TaskId;
  run_id?: RunId;
  summary_token_count: number;
  summary_fields: string[];
}

export function buildSweEvoEvaluationTelemetry(
  input: SweEvoEvaluationTelemetryInput,
): TelemetryEmission {
  return {
    event_type: 'harness.swe_evo_evaluated',
    subject_id: input.instance_id,
    subject_type: 'swe_evo_instance',
    ...(input.run_id ? { run_id: input.run_id } : {}),
    ...(input.task_id ? { task_id: input.task_id } : {}),
    payload: {
      instance_id: input.instance_id,
      instance_seq: input.instance_seq,
      resolved: input.resolved,
      ...(input.fix_rate !== undefined ? { fix_rate: input.fix_rate } : {}),
      ...(input.f2p ? { f2p: input.f2p } : {}),
      applied: input.applied,
      p2p_regression: input.p2p_regression,
      ...(input.memory_ablation ? { memory_ablation: input.memory_ablation } : {}),
    },
    source: { kind: 'harness', object_type: 'SWE-EVO evaluate' },
  };
}

export function buildCooperBenchEvaluationTelemetry(
  input: CooperBenchEvaluationTelemetryInput,
): TelemetryEmission {
  return {
    event_type: 'harness.cooperbench_evaluated',
    subject_id: input.case_id,
    subject_type: 'cooperbench_case',
    ...(input.run_id ? { run_id: input.run_id } : {}),
    ...(input.task_id ? { task_id: input.task_id } : {}),
    payload: {
      case_id: input.case_id,
      both_passed: input.both_passed,
      coordination_deficit: input.coordination_deficit,
      failure_taxonomy: input.failure_taxonomy,
    },
    source: { kind: 'harness', object_type: 'CooperBench evaluate' },
  };
}

export function buildProxyUsageTelemetry(input: ProxyUsageTelemetryInput): TelemetryEmission {
  return {
    event_type: 'proxy.llm_usage_recorded',
    subject_id: input.case_id,
    subject_type: 'llm_call',
    ...(input.run_id ? { run_id: input.run_id } : {}),
    ...(input.task_id ? { task_id: input.task_id } : {}),
    payload: {
      case_id: input.case_id,
      input_tokens: input.input_tokens,
      output_tokens: input.output_tokens,
      ...(input.model ? { model: input.model } : {}),
    },
    source: { kind: 'proxy', object_type: 'LLM call' },
  };
}

export function buildAgentCrashTelemetry(input: AgentCrashTelemetryInput): TelemetryEmission {
  return {
    event_type: 'eval.agent_crash',
    subject_id: input.task_id,
    subject_type: 'task',
    ...(input.run_id ? { run_id: input.run_id } : {}),
    task_id: input.task_id,
    payload: {
      kill_at: input.kill_at,
      progress_pct: input.progress_pct,
      tool_call_count: input.tool_call_count,
      had_checkpoint: input.had_checkpoint,
      kill_at_status: input.kill_at_status,
      ...(input.checkpoint_id_at_kill
        ? { checkpoint_id_at_kill: input.checkpoint_id_at_kill }
        : {}),
    },
    source: { kind: 'harness', object_type: 'P2 perturbation controller' },
  };
}

export function buildColdRestartTelemetry(input: ColdRestartTelemetryInput): TelemetryEmission {
  return {
    event_type: 'eval.cold_restart',
    subject_id: input.task_id,
    subject_type: 'task',
    ...(input.run_id ? { run_id: input.run_id } : {}),
    task_id: input.task_id,
    payload: {
      summary_token_count: input.summary_token_count,
      summary_fields: input.summary_fields,
    },
    source: { kind: 'harness', object_type: 'P2 cold restart baseline' },
  };
}
