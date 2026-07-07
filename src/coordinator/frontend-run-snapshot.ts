/**
 * Coordinator 前端运行快照模块。
 *
 * 这个文件只负责把 integration-v0 已有输出整理成前端可读 view model。
 * 它不读取/写入文件，不调用 driver、gate、council 或 mailbox，也不修改 task/run 状态。
 */
import type { Checkpoint, Message, MessageId, SchemaVersion, Timestamp } from '../core';
import type { ArtifactOutput } from './artifact-output';
import type { RunResultStatus, IntegrationRunOutputPaths } from './run-result';
import type { SelectionMode } from './artifact-finalizer';

export type FrontendStage = 'executing' | 'council' | 'delivery';
export type FrontendTimelineLevel = 'info' | 'success' | 'warning' | 'council';

export interface FrontendRunSnapshotSummary {
  run_id: string;
  task_id: string;
  mode: SelectionMode;
  status: RunResultStatus;
  worktree_path: string;
  artifacts_materialized: number;
  files_written: string[];
  artifact_outputs: ArtifactOutput[];
  driver_diagnostics: {
    driver_id: string;
    duration_ms: number;
  };
  checkpoint_id: string;
  checkpoint_path: string;
  mailbox_message_refs: MessageId[];
  mailbox_thread_id: string;
  created_at: Timestamp;
  schema_version: SchemaVersion;
}

export interface FrontendRunSnapshotTimelineItem {
  id: string;
  name: string;
}

export interface BuildFrontendRunSnapshotInput {
  summary: FrontendRunSnapshotSummary;
  timeline: readonly FrontendRunSnapshotTimelineItem[];
  checkpoint: Checkpoint;
  message_thread: readonly Message[];
  links: Omit<IntegrationRunOutputPaths, 'run_dir'>;
}

export interface FrontendRunSnapshot {
  snapshot_type: 'coordinator.frontend_run_snapshot.v0';
  schema_version: SchemaVersion;
  generated_at: Timestamp;
  run_id: string;
  task_id: string;
  current: {
    stage: FrontendStage;
    task_status: RunResultStatus;
    active_node_code: string;
  };
  run: {
    run_id: string;
    task_id: string;
    status: RunResultStatus;
    mode: SelectionMode;
    driver_id: string;
    created_at: Timestamp;
  };
  timeline: Array<{
    id: string;
    name: string;
    level: FrontendTimelineLevel;
    source: string;
    text: string;
  }>;
  delivery_report: {
    worktree_path: string;
    files_written: string[];
    artifacts_materialized: number;
    driver_diagnostics: FrontendRunSnapshotSummary['driver_diagnostics'];
  };
  artifacts: ArtifactOutput[];
  checkpoint: {
    checkpoint_id: string;
    trigger: Checkpoint['trigger'];
    validity_status: Checkpoint['validity_status'];
    semantic_handoff: Checkpoint['semantic_handoff'];
    mechanical_snapshot: Checkpoint['mechanical_snapshot'];
  };
  mailbox: {
    thread_id: string;
    message_refs: MessageId[];
    messages: Message[];
  };
  links: Omit<IntegrationRunOutputPaths, 'run_dir'>;
}

export function buildFrontendRunSnapshot(
  input: BuildFrontendRunSnapshotInput,
): FrontendRunSnapshot {
  return {
    snapshot_type: 'coordinator.frontend_run_snapshot.v0',
    schema_version: input.summary.schema_version,
    generated_at: input.summary.created_at,
    run_id: input.summary.run_id,
    task_id: input.summary.task_id,
    current: {
      stage: getFrontendStage(input.summary),
      task_status: input.summary.status,
      active_node_code: input.summary.status === 'completed' ? 'N18' : 'N8',
    },
    run: {
      run_id: input.summary.run_id,
      task_id: input.summary.task_id,
      status: input.summary.status,
      mode: input.summary.mode,
      driver_id: input.summary.driver_diagnostics.driver_id,
      created_at: input.summary.created_at,
    },
    timeline: input.timeline.map((item) => ({
      id: item.id,
      name: item.name,
      level: getTimelineLevel(item.name),
      source: getTimelineSource(item.name),
      text: item.name,
    })),
    delivery_report: {
      worktree_path: input.summary.worktree_path,
      files_written: [...input.summary.files_written],
      artifacts_materialized: input.summary.artifacts_materialized,
      driver_diagnostics: input.summary.driver_diagnostics,
    },
    artifacts: [...input.summary.artifact_outputs],
    checkpoint: {
      checkpoint_id: input.checkpoint.checkpoint_id,
      trigger: input.checkpoint.trigger,
      validity_status: input.checkpoint.validity_status,
      semantic_handoff: input.checkpoint.semantic_handoff,
      mechanical_snapshot: input.checkpoint.mechanical_snapshot,
    },
    mailbox: {
      thread_id: input.summary.mailbox_thread_id,
      message_refs: [...input.summary.mailbox_message_refs],
      messages: [...input.message_thread],
    },
    links: input.links,
  };
}

function getFrontendStage(summary: FrontendRunSnapshotSummary): FrontendStage {
  if (summary.mode === 'council') {
    return 'council';
  }
  return summary.status === 'completed' || summary.status === 'failed' ? 'delivery' : 'executing';
}

function getTimelineLevel(name: string): FrontendTimelineLevel {
  if (name.includes('Failed')) return 'warning';
  if (name.includes('Council')) return 'council';
  if (name.includes('Completed')) return 'success';
  return 'info';
}

function getTimelineSource(name: string): string {
  if (name.includes('Driver')) return 'Driver';
  if (name.includes('Gate') || name.includes('Hook')) return 'Gate';
  if (name.includes('Council')) return 'Council';
  return 'Coordinator';
}
