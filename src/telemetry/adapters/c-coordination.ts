import type { Checkpoint, Event, RunId, TaskId } from '../../core';
import { getTelemetryCatalogEntry } from '../event-catalog';
import type { TelemetryEmission } from '../telemetry-sink';

export interface ResumePackageObservation {
  task_id: TaskId;
  run_id?: RunId;
  checkpoint_id: string;
  restored_status: string;
  next_action: 'continue' | 'wait' | 'rerun' | 'ask_human' | 'fail';
  resume_cursor?: string;
  replayed_incremental_count?: number;
  message_thread?: unknown[];
  scheduling?: Record<string, unknown>;
  se_domain_state?: Record<string, unknown>;
  semantic_handoff?: Record<string, unknown>;
}

export interface MessageDeliveryObservation {
  delivery_id: string;
  message_id: string;
  recipient_agent_id: string;
  status: 'pending' | 'delivered' | 'acked' | 'timeout' | 'failed' | string;
  task_id?: TaskId;
  run_id?: RunId;
  ack_at?: string;
}

export interface FileLeaseObservation {
  lease_id: string;
  holder_id: string;
  path_glob: string;
  status: string;
  task_id?: TaskId;
  run_id?: RunId;
}

export interface AnchorValidationObservation {
  task_id: TaskId;
  run_id?: RunId;
  base_commit: string;
  modified_files: Array<{ path: string; hash: string }>;
}

export function isCatalogedCoordinationEvent(event: Event): boolean {
  return getTelemetryCatalogEntry(event.event_type)?.owner === 'C-owned-observed';
}

export function observeCoordinationEvent(event: Event): TelemetryEmission | undefined {
  if (!isCatalogedCoordinationEvent(event)) {
    return undefined;
  }

  return {
    event_type: event.event_type,
    subject_id: event.subject_id,
    ...(event.run_id ? { run_id: event.run_id } : {}),
    ...(event.task_id ? { task_id: event.task_id } : {}),
    payload: event.payload,
    source: {
      kind: 'event_store',
      event_id: event.event_id,
    },
  };
}

export function observeCheckpoint(checkpoint: Checkpoint): TelemetryEmission {
  return {
    event_type: 'coord.checkpoint_observed',
    subject_id: checkpoint.checkpoint_id,
    subject_type: 'checkpoint',
    task_id: checkpoint.task_id,
    payload: {
      checkpoint_id: checkpoint.checkpoint_id,
      checkpoint_type: checkpoint.checkpoint_type,
      trigger: checkpoint.trigger,
      parent_checkpoint_id: checkpoint.parent_checkpoint_id,
      artifact_refs: checkpoint.artifact_refs,
      mechanical_snapshot: checkpoint.mechanical_snapshot,
      semantic_handoff: checkpoint.semantic_handoff,
      runtime_state: checkpoint.runtime_state,
      interrupt_state: checkpoint.interrupt_state,
      validity_status: checkpoint.validity_status,
    },
    source: { kind: 'c_coordination', object_type: 'Checkpoint' },
  };
}

export function observeResumePackage(input: ResumePackageObservation): TelemetryEmission {
  return {
    event_type: 'coord.resume_package_observed',
    subject_id: input.checkpoint_id,
    subject_type: 'resume_package',
    ...(input.run_id ? { run_id: input.run_id } : {}),
    task_id: input.task_id,
    payload: {
      checkpoint_id: input.checkpoint_id,
      restored_status: input.restored_status,
      next_action: input.next_action,
      ...(input.resume_cursor ? { resume_cursor: input.resume_cursor } : {}),
      ...(input.replayed_incremental_count !== undefined
        ? { replayed_incremental_count: input.replayed_incremental_count }
        : {}),
      ...(input.message_thread ? { message_thread: input.message_thread } : {}),
      ...(input.scheduling ? { scheduling: input.scheduling } : {}),
      ...(input.se_domain_state ? { se_domain_state: input.se_domain_state } : {}),
      ...(input.semantic_handoff ? { semantic_handoff: input.semantic_handoff } : {}),
    },
    source: { kind: 'c_coordination', object_type: 'ResumePackage' },
  };
}

export function observeMessageDelivery(input: MessageDeliveryObservation): TelemetryEmission {
  return {
    event_type: 'coord.message_delivery_observed',
    subject_id: input.delivery_id,
    subject_type: 'message_delivery',
    ...(input.run_id ? { run_id: input.run_id } : {}),
    ...(input.task_id ? { task_id: input.task_id } : {}),
    payload: {
      delivery_id: input.delivery_id,
      message_id: input.message_id,
      recipient_agent_id: input.recipient_agent_id,
      status: input.status,
      ...(input.ack_at ? { ack_at: input.ack_at } : {}),
    },
    source: { kind: 'c_coordination', object_type: 'MessageDelivery' },
  };
}

export function observeFileLease(input: FileLeaseObservation): TelemetryEmission {
  return {
    event_type: 'coord.file_lease_observed',
    subject_id: input.lease_id,
    subject_type: 'file_lease',
    ...(input.run_id ? { run_id: input.run_id } : {}),
    ...(input.task_id ? { task_id: input.task_id } : {}),
    payload: {
      lease_id: input.lease_id,
      holder_id: input.holder_id,
      path_glob: input.path_glob,
      status: input.status,
    },
    source: { kind: 'c_coordination', object_type: 'FileLease' },
  };
}

export function observeAnchorValidation(input: AnchorValidationObservation): TelemetryEmission {
  return {
    event_type: 'coord.anchor_validation_observed',
    subject_id: input.task_id,
    subject_type: 'anchor_validation',
    ...(input.run_id ? { run_id: input.run_id } : {}),
    task_id: input.task_id,
    payload: {
      base_commit: input.base_commit,
      modified_files: input.modified_files,
    },
    source: { kind: 'c_coordination', object_type: 'anchor validation' },
  };
}
