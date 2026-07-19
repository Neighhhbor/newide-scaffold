import type { Event, RiskLevel, SchemaVersion, TaskBudget, TaskStatus } from '../core';
import type { RunSnapshot } from '../protocol/run-snapshot';

export type PersistedRunMode = 'single_agent' | 'council';
export type PersistedRunStatus =
  | 'created'
  | 'running'
  | 'interrupted'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type TaskResumeCursor =
  | 'select_agent'
  | 'execute_agent'
  | 'council'
  | 'gate'
  | 'deliver'
  | 'mailbox_wait'
  | 'done';

export type TaskCursorInput =
  | {
      cursor: 'select_agent';
      seed: string;
      candidate_ids: string[];
      market_evidence_ref?: string;
    }
  | {
      cursor: 'execute_agent';
      winner_agent_id: string;
      execution_evidence_ref?: string;
    }
  | {
      cursor: 'council';
      trigger: string;
      primary_evidence_ref?: string;
      candidate_manifest_ref?: string;
    }
  | {
      cursor: 'gate';
      subject_ref: string;
      phase: string;
    }
  | {
      cursor: 'deliver';
      changeset_ref: string;
      expected_sha256: string;
    }
  | {
      cursor: 'mailbox_wait';
      delivery_ids: string[];
      waiting_reason: string;
    }
  | {
      cursor: 'done';
    };

export interface PersistedTaskError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface PersistedTaskFinalOutput {
  artifact_ref: string;
  sha256: string;
  workspace_path: string;
}

export interface PersistedTaskState {
  task_id: string;
  parent_id?: string;
  status: TaskStatus;
  owner_agent_id?: string;
  role_id?: string;
  risk_level: RiskLevel;
  spec: string;
  completion_criteria: string[];
  affected_paths: string[];
  budget?: TaskBudget;
  workspace_path: string;
  warnings: string[];
  final_output?: PersistedTaskFinalOutput;
  error?: PersistedTaskError;
  revision: number;
  created_at: string;
  updated_at: string;
  schema_version: SchemaVersion;
}

export interface PersistedRunState {
  run_id: string;
  task_id: string;
  status: PersistedRunStatus;
  mode: PersistedRunMode;
  workspace_path: string;
  session_id?: string;
  restarted_from_run_id?: string;
  snapshot?: RunSnapshot;
  error?: PersistedTaskError;
  revision: number;
  started_at?: string;
  completed_at?: string;
  created_at: string;
  updated_at: string;
  schema_version: SchemaVersion;
}

export interface PersistedTaskRuntimeState {
  task_id: string;
  current_run_id?: string;
  resume_cursor: TaskResumeCursor;
  cursor_input?: TaskCursorInput;
  waiting_on: Record<string, unknown>[];
  interrupt_state?: Record<string, unknown>;
  artifact_refs: string[];
  diagnostics: Record<string, unknown>;
  updated_at: string;
  schema_version: SchemaVersion;
}

export interface PersistedCoordinationEvent extends Event {
  sequence: number;
}

export interface PersistedCheckpointMessage {
  message_id: string;
  role: string;
  content: string;
  turn: number;
  artifact_refs: string[];
  created_at: string;
}

export interface PersistedFullCheckpoint {
  checkpoint_id: string;
  parent_checkpoint_id?: string;
  task_id: string;
  run_id: string;
  agent_id: string;
  session_id?: string;
  trigger: 'manual' | 'periodic' | 'shutdown' | 'blocked' | 'escalated';
  resume_cursor: TaskResumeCursor;
  message_thread: PersistedCheckpointMessage[];
  mechanical_snapshot: {
    base_commit: string;
    snapshot_commit?: string;
    worktree_path: string;
    branch: string;
    modified_files: string[];
    diff_artifact_id?: string;
    test_artifact_ids?: string[];
  };
  semantic_handoff: {
    done: string[];
    in_progress: string[];
    blocked_on: string[];
    assumptions: string[];
    next_steps: string[];
    known_risks: string[];
  };
  interrupt_state?: Record<string, unknown>;
  artifact_refs: string[];
  validity_status: 'valid' | 'invalid' | 'superseded';
  created_at: string;
  schema_version: SchemaVersion;
}

export interface CoordinationStateCommit {
  expected_task_revision?: number;
  task: PersistedTaskState;
  run?: PersistedRunState;
  runtime_state: PersistedTaskRuntimeState;
  checkpoint?: PersistedFullCheckpoint;
  events: Event[];
}

export interface PersistedTaskAggregate {
  task: PersistedTaskState;
  runs: PersistedRunState[];
  runtime_state: PersistedTaskRuntimeState;
  events: PersistedCoordinationEvent[];
}

export interface CoordinationStateStore {
  commitState(input: CoordinationStateCommit): PersistedCoordinationEvent[];
  getTaskAggregate(taskId: string): PersistedTaskAggregate | undefined;
  listTaskAggregates(): PersistedTaskAggregate[];
  listEvents(taskId: string, afterSequence?: number): PersistedCoordinationEvent[];
  getLatestCheckpoint(taskId: string): PersistedFullCheckpoint | undefined;
  close(): void;
}
