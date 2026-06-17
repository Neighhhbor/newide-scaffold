import type { AgentId, ArtifactId, CheckpointId, SchemaVersion, TaskId, Timestamp } from './ids';

export type CheckpointType = 'full' | 'incremental';
export type CheckpointTrigger = 'manual' | 'periodic' | 'shutdown' | 'blocked' | 'escalated';
export type CheckpointValidity = 'valid' | 'invalid' | 'superseded';

export interface MechanicalSnapshot {
  base_commit: string;
  snapshot_commit?: string;
  worktree_path: string;
  branch: string;
  modified_files: string[];
  diff_artifact_id?: ArtifactId;
  test_artifact_ids?: ArtifactId[];
}

export interface SemanticHandoff {
  done: string[];
  in_progress: string[];
  blocked_on: string[];
  assumptions: string[];
  next_steps: string[];
  known_risks: string[];
}

export interface RuntimeStateSnapshot {
  scheduler_policy?: string;
  current_turn?: number;
  next_agent_ref?: string;
  resume_cursor?: string;
}

export interface InterruptState {
  waiting_for: string[];
  timeout_at?: Timestamp;
  resume_condition?: string;
  resume_value_artifact_id?: ArtifactId;
}

export interface Checkpoint {
  checkpoint_id: CheckpointId;
  parent_checkpoint_id?: CheckpointId;
  checkpoint_type: CheckpointType;
  task_id: TaskId;
  agent_id?: AgentId;
  trigger: CheckpointTrigger;
  mechanical_snapshot: MechanicalSnapshot;
  semantic_handoff: SemanticHandoff;
  runtime_state?: RuntimeStateSnapshot;
  interrupt_state?: InterruptState;
  artifact_refs: ArtifactId[];
  validity_status: CheckpointValidity;
  created_at: Timestamp;
  schema_version: SchemaVersion;
}
