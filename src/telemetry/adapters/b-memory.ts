import type { DriverRunResult } from '../../driver';
import type { ContextPack } from '../../memory';
import type { RunId, TaskId } from '../../core';
import type { TelemetryEmission } from '../telemetry-sink';

export interface DriverReturnObservation {
  decisions?: unknown[];
  blockers?: unknown[];
  assumptions?: unknown[];
  referenced_experiences?: unknown[];
}

export interface ExtractResultObservation {
  experiences_created: number;
  experiences_updated: number;
  negative_experiences: number;
  skills_promoted: number;
  [key: string]: unknown;
}

export interface AgentMetricsObservation {
  role_id: string;
  token_cost_total?: number;
  total_tasks?: number;
  tasks_completed?: number;
  tasks_succeeded?: number;
  skill_count?: number;
  experience_count?: number;
  persona_version?: number;
  [key: string]: unknown;
}

export interface ContextPackTelemetryInput {
  context_pack: ContextPack;
  run_id?: RunId;
  ablation?: string;
  retrieved_experience_ids?: string[];
  retrieved_skill_ids?: string[];
  retrieved_persona_ids?: string[];
  top_k_scores?: number[];
}

export interface DriverRunResultTelemetryInput {
  driver_result: DriverRunResult;
  task_id: TaskId;
  run_id: RunId;
  driver_return?: DriverReturnObservation;
}

export interface BufferReportReceivedTelemetryInput {
  task_id: TaskId;
  source_driver: string;
  buffer_seq: number;
  extraction_status: 'pending' | 'processing' | 'processed' | 'dead_letter';
  run_id?: RunId;
}

export interface ExtractionTriggeredTelemetryInput {
  task_id: TaskId;
  trigger: 'capacity' | 'time' | 'priority' | string;
  pending_count: number;
  run_id?: RunId;
}

export interface ExtractionCompletedTelemetryInput {
  task_id: TaskId;
  extract_result: ExtractResultObservation;
  run_id?: RunId;
  batch_id?: string;
}

export interface ConfidenceUpdatedTelemetryInput {
  task_id?: TaskId;
  experience_id: string;
  old_confidence: number;
  new_confidence: number;
  confidence_history: unknown[];
  run_id?: RunId;
}

export interface SkillPromotedTelemetryInput {
  task_id?: TaskId;
  experience_id: string;
  skill_id: string;
  review_status: string;
  run_id?: RunId;
}

export interface PersonaUpdatedTelemetryInput {
  task_id?: TaskId;
  role_id: string;
  persona_version: number;
  trigger_reason: string;
  run_id?: RunId;
}

export interface AgentLifecycleTelemetryInput {
  role_id: string;
  action: 'created' | 'activated' | 'idled' | 'draining' | 'respawned' | 'retired' | string;
  trigger: string;
  task_id?: TaskId;
  run_id?: RunId;
}

export function observeContextPackBuilt(input: ContextPackTelemetryInput): TelemetryEmission {
  const contextPack = input.context_pack;

  return {
    event_type: 'memory.context_pack_built',
    subject_id: contextPack.context_pack_id,
    subject_type: 'context_pack',
    ...(input.run_id ? { run_id: input.run_id } : {}),
    task_id: contextPack.task_id,
    payload: {
      role_id: contextPack.role_profile_ref.role_id,
      memory_refs: contextPack.memory_refs.map((memoryRef) => memoryRef.memory_id),
      artifact_refs: contextPack.artifact_refs,
      ...(input.ablation ? { ablation: input.ablation } : {}),
      ...(input.retrieved_experience_ids
        ? { retrieved_experience_ids: input.retrieved_experience_ids }
        : {}),
      ...(input.retrieved_skill_ids ? { retrieved_skill_ids: input.retrieved_skill_ids } : {}),
      ...(input.retrieved_persona_ids
        ? { retrieved_persona_ids: input.retrieved_persona_ids }
        : {}),
      ...(input.top_k_scores ? { top_k_scores: input.top_k_scores } : {}),
    },
    source: { kind: 'b_memory', object_type: 'ContextPack' },
  };
}

export function observeDriverRunResult(input: DriverRunResultTelemetryInput): TelemetryEmission[] {
  const baseEmission: TelemetryEmission = {
    event_type: 'driver.run_result',
    subject_id: input.driver_result.driver_run_result_id,
    subject_type: 'driver_run_result',
    run_id: input.run_id,
    task_id: input.task_id,
    payload: {
      status: input.driver_result.status,
      artifact_refs: input.driver_result.artifacts.map((artifact) => artifact.artifact_id),
      transcript_ref: input.driver_result.transcript_ref.artifact_id,
      tool_events: input.driver_result.tool_events,
      diagnostics: input.driver_result.diagnostics,
      ...(input.driver_return ? { driver_return: input.driver_return } : {}),
    },
    source: { kind: 'b_memory', object_type: 'DriverRunResult' },
  };

  const referencedExperiences = input.driver_return?.referenced_experiences;
  if (!referencedExperiences || referencedExperiences.length === 0) {
    return [baseEmission];
  }

  return [
    baseEmission,
    {
      event_type: 'memory.experience_referenced',
      subject_id: input.driver_result.driver_run_result_id,
      subject_type: 'driver_return',
      run_id: input.run_id,
      task_id: input.task_id,
      payload: {
        referenced_experiences: referencedExperiences,
      },
      source: { kind: 'b_memory', object_type: 'DriverReturn.referenced_experiences' },
    },
  ];
}

export function observeBufferReportReceived(
  input: BufferReportReceivedTelemetryInput,
): TelemetryEmission {
  return {
    event_type: 'buffer.report_received',
    subject_id: `${input.source_driver}:${input.buffer_seq}`,
    subject_type: 'buffer_snapshot',
    ...(input.run_id ? { run_id: input.run_id } : {}),
    task_id: input.task_id,
    payload: {
      task_id: input.task_id,
      source_driver: input.source_driver,
      buffer_seq: input.buffer_seq,
      extraction_status: input.extraction_status,
    },
    source: { kind: 'b_memory', object_type: 'BufferSnapshot' },
  };
}

export function observeExtractionTriggered(
  input: ExtractionTriggeredTelemetryInput,
): TelemetryEmission {
  return {
    event_type: 'memory.extraction_triggered',
    subject_id: input.task_id,
    subject_type: 'buffer_meta',
    ...(input.run_id ? { run_id: input.run_id } : {}),
    task_id: input.task_id,
    payload: {
      trigger: input.trigger,
      pending_count: input.pending_count,
    },
    source: { kind: 'b_memory', object_type: 'BufferMeta' },
  };
}

export function observeExtractionCompleted(
  input: ExtractionCompletedTelemetryInput,
): TelemetryEmission {
  return {
    event_type: 'memory.extraction_completed',
    subject_id: input.batch_id ?? input.task_id,
    subject_type: 'extract_result',
    ...(input.run_id ? { run_id: input.run_id } : {}),
    task_id: input.task_id,
    payload: {
      extract_result: input.extract_result,
    },
    source: { kind: 'b_memory', object_type: 'ExtractResult' },
  };
}

export function observeConfidenceUpdated(
  input: ConfidenceUpdatedTelemetryInput,
): TelemetryEmission {
  return {
    event_type: 'memory.confidence_updated',
    subject_id: input.experience_id,
    subject_type: 'experience',
    ...(input.run_id ? { run_id: input.run_id } : {}),
    ...(input.task_id ? { task_id: input.task_id } : {}),
    payload: {
      experience_id: input.experience_id,
      old_confidence: input.old_confidence,
      new_confidence: input.new_confidence,
      confidence_history: input.confidence_history,
    },
    source: { kind: 'b_memory', object_type: 'ExperienceRecord' },
  };
}

export function observeSkillPromoted(input: SkillPromotedTelemetryInput): TelemetryEmission {
  return {
    event_type: 'memory.skill_promoted',
    subject_id: input.skill_id,
    subject_type: 'skill',
    ...(input.run_id ? { run_id: input.run_id } : {}),
    ...(input.task_id ? { task_id: input.task_id } : {}),
    payload: {
      experience_id: input.experience_id,
      skill_id: input.skill_id,
      review_status: input.review_status,
    },
    source: { kind: 'b_memory', object_type: 'SkillRecord' },
  };
}

export function observePersonaUpdated(input: PersonaUpdatedTelemetryInput): TelemetryEmission {
  return {
    event_type: 'memory.persona_updated',
    subject_id: input.role_id,
    subject_type: 'persona',
    ...(input.run_id ? { run_id: input.run_id } : {}),
    ...(input.task_id ? { task_id: input.task_id } : {}),
    payload: {
      persona_version: input.persona_version,
      trigger_reason: input.trigger_reason,
    },
    source: { kind: 'b_memory', object_type: 'PersonaDef' },
  };
}

export function observeAgentMetricsUpdated(input: AgentMetricsObservation): TelemetryEmission {
  return {
    event_type: 'metrics.updated',
    subject_id: input.role_id,
    subject_type: 'agent_metrics',
    payload: {
      agent_metrics: input,
    },
    source: { kind: 'b_memory', object_type: 'AgentMetrics' },
  };
}

export function observeAgentLifecycle(input: AgentLifecycleTelemetryInput): TelemetryEmission {
  return {
    event_type: 'memory.agent_lifecycle',
    subject_id: input.role_id,
    subject_type: 'agent_handle',
    ...(input.run_id ? { run_id: input.run_id } : {}),
    ...(input.task_id ? { task_id: input.task_id } : {}),
    payload: {
      action: input.action,
      trigger: input.trigger,
    },
    source: { kind: 'b_memory', object_type: 'AgentHandle' },
  };
}
