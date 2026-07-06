import type { RunId, TaskId } from '../../core';
import type { TelemetryEmission } from '../telemetry-sink';

export interface CouncilRoundObservationBase {
  council_id: string;
  task_id?: TaskId;
  run_id?: RunId;
}

export interface CouncilStartedObservation extends CouncilRoundObservationBase {
  phase: 'started';
  trigger: 'user_choice' | 'agent_escalate' | 'gate_defer' | 'manual' | string;
  decision_mode: string;
  topology: string;
  participant_ids: string[];
}

export interface CouncilReviewRoundEndObservation extends CouncilRoundObservationBase {
  phase: 'review_round_end';
  current_round_count: number;
  round_participants?: string[];
  active_edges?: string[];
}

export interface CouncilExtractionCompletedObservation extends CouncilRoundObservationBase {
  phase: 'extraction_completed';
  raw_input_tokens: number;
  extracted_input_tokens: number;
  context_extraction_saved_tokens: number;
  context_mode: string;
}

export interface CouncilCompletedObservation extends CouncilRoundObservationBase {
  phase: 'completed';
  duration_ms: number;
  total_rounds: number;
}

export type CouncilRoundObservation =
  | CouncilStartedObservation
  | CouncilReviewRoundEndObservation
  | CouncilExtractionCompletedObservation
  | CouncilCompletedObservation;

export interface DecisionPacketObservation {
  council_id: string;
  task_id?: TaskId;
  run_id?: RunId;
  identity_mapping: Record<string, string>;
  final_selected_driver: string;
  judge_raw_scores: Record<string, number>;
  judge_rationale_text: string;
}

export interface CoordinationTraceObservation {
  council_id: string;
  task_id?: TaskId;
  run_id?: RunId;
  current_round_count: number;
  termination_reason: 'consensus' | 'max_rounds_exceeded' | 'timeout' | 'escalated' | string;
  is_escalated: boolean;
}

export interface TokenTrackerObservation {
  council_id: string;
  task_id?: TaskId;
  run_id?: RunId;
  raw_input_tokens: number;
  extracted_input_tokens: number;
  context_extraction_saved_tokens: number;
  total_input_tokens: number;
  total_output_tokens: number;
}

const COUNCIL_PHASE_EVENT_TYPE: Record<CouncilRoundObservation['phase'], string> = {
  started: 'council.started',
  review_round_end: 'council.review_round_end',
  extraction_completed: 'council.extraction_completed',
  completed: 'council.completed',
};

export function observeCouncilRound(input: CouncilRoundObservation): TelemetryEmission {
  const eventType = COUNCIL_PHASE_EVENT_TYPE[input.phase];
  const { council_id, task_id, run_id, phase: _phase, ...payload } = input;

  return {
    event_type: eventType,
    subject_id: council_id,
    subject_type: 'council_session',
    ...(run_id ? { run_id } : {}),
    ...(task_id ? { task_id } : {}),
    payload,
    source: { kind: 'c_coordination', object_type: 'CouncilRound' },
  };
}

export function observeDecisionPacket(input: DecisionPacketObservation): TelemetryEmission {
  return {
    event_type: 'audit.decision_packet_observed',
    subject_id: input.council_id,
    subject_type: 'decision_audit_packet',
    ...(input.run_id ? { run_id: input.run_id } : {}),
    ...(input.task_id ? { task_id: input.task_id } : {}),
    payload: {
      identity_mapping: input.identity_mapping,
      final_selected_driver: input.final_selected_driver,
      judge_raw_scores: input.judge_raw_scores,
      judge_rationale_text: input.judge_rationale_text,
    },
    source: { kind: 'c_coordination', object_type: 'DecisionPacket' },
  };
}

export function observeCoordinationTrace(input: CoordinationTraceObservation): TelemetryEmission {
  return {
    event_type: 'audit.coordination_trace_observed',
    subject_id: input.council_id,
    subject_type: 'coordination_trace',
    ...(input.run_id ? { run_id: input.run_id } : {}),
    ...(input.task_id ? { task_id: input.task_id } : {}),
    payload: {
      current_round_count: input.current_round_count,
      termination_reason: input.termination_reason,
      is_escalated: input.is_escalated,
    },
    source: { kind: 'c_coordination', object_type: 'CoordinationTrace' },
  };
}

export function observeTokenTracker(input: TokenTrackerObservation): TelemetryEmission {
  return {
    event_type: 'audit.token_tracker_observed',
    subject_id: input.council_id,
    subject_type: 'token_tracker',
    ...(input.run_id ? { run_id: input.run_id } : {}),
    ...(input.task_id ? { task_id: input.task_id } : {}),
    payload: {
      raw_input_tokens: input.raw_input_tokens,
      extracted_input_tokens: input.extracted_input_tokens,
      context_extraction_saved_tokens: input.context_extraction_saved_tokens,
      total_input_tokens: input.total_input_tokens,
      total_output_tokens: input.total_output_tokens,
    },
    source: { kind: 'c_coordination', object_type: 'TokenTracker' },
  };
}
