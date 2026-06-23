import {
  SCHEMA_VERSION,
  createId,
  nowTimestamp,
  type AgentId,
  type ArtifactId,
  type CheckpointTrigger,
  type CheckpointType,
  type Checkpoint as CoreCheckpoint,
  type CheckpointId,
  type InterruptState,
  type MechanicalSnapshot,
  type RunId,
  type RuntimeStateSnapshot,
  type SchemaVersion,
  type SemanticHandoff,
  type TaskId,
  type ThreadId,
  type Timestamp,
} from '../core';

export type CoordinatorCheckpointType = CheckpointType;
export type CoordinatorCheckpointTrigger = CheckpointTrigger;
export type CoordinatorCheckpointValidity = 'valid' | 'invalid' | 'needs_migration';

export interface CoordinatorMessageThreadEntry {
  message_id?: string;
  role: string;
  content: string;
  turn: number;
  artifact_refs?: ArtifactId[];
  created_at?: Timestamp;
}

export interface CoordinatorSchedulingState {
  policy: 'single_agent' | 'round_robin' | 'manual' | (string & {});
  current_turn: number;
  next_agent_ref?: string;
  next_speaker_index?: number;
  agent_order?: string[];
}

export type CoordinatorMechanicalSnapshot = MechanicalSnapshot;
export type CoordinatorSemanticHandoff = SemanticHandoff;
export type CoordinatorInterruptState = InterruptState;
export type CoordinatorRuntimeStateSnapshot = RuntimeStateSnapshot;

export interface CoordinatorCheckpointArtifactRefs {
  git_commit_hash?: string;
  [key: string]: unknown;
}

export interface CoordinatorCheckpointRequest {
  thread_id: ThreadId;
  task_id: TaskId;
  run_id?: RunId;
  agent_id?: AgentId;
  trigger: CoordinatorCheckpointTrigger;
  parent_checkpoint_id?: CheckpointId;
  checkpoint_type: CoordinatorCheckpointType;
  schema_version: SchemaVersion;
  message_thread: CoordinatorMessageThreadEntry[];
  scheduling: CoordinatorSchedulingState;
  se_domain_state: Record<string, unknown>;
  mechanical_snapshot: CoordinatorMechanicalSnapshot;
  semantic_handoff: CoordinatorSemanticHandoff;
  runtime_state?: CoordinatorRuntimeStateSnapshot;
  interrupt_state?: CoordinatorInterruptState | null;
  artifact_refs?: CoordinatorCheckpointArtifactRefs;
}

export interface CoordinatorCheckpoint {
  checkpoint_id: CheckpointId;
  thread_id: ThreadId;
  parent_checkpoint_id?: CheckpointId | null;
  checkpoint_type: CoordinatorCheckpointType;
  schema_version: SchemaVersion;
  task_id: TaskId;
  run_id?: RunId;
  agent_id?: AgentId;
  trigger: CoordinatorCheckpointTrigger;
  message_thread: CoordinatorMessageThreadEntry[];
  scheduling: CoordinatorSchedulingState;
  se_domain_state: Record<string, unknown>;
  mechanical_snapshot: CoordinatorMechanicalSnapshot;
  semantic_handoff: CoordinatorSemanticHandoff;
  runtime_state?: CoordinatorRuntimeStateSnapshot;
  interrupt_state?: CoordinatorInterruptState | null;
  artifact_refs: CoordinatorCheckpointArtifactRefs;
  validity_status: CoordinatorCheckpointValidity;
  created_at: Timestamp;
}

export interface CoordinatorCheckpointHistoryOptions {
  limit?: number;
  offset?: number;
}

export interface CoordinatorCheckpointMeta {
  checkpoint_id: CheckpointId;
  parent_checkpoint_id: CheckpointId | null;
  checkpoint_type: CoordinatorCheckpointType;
  schema_version: SchemaVersion;
  timestamp: Timestamp;
  trigger: CoordinatorCheckpointTrigger;
  message_count: number;
  turn_count: number;
}

export interface CoordinatorCheckpointForkResult {
  new_thread_id: ThreadId;
  fork_from_checkpoint_id: CheckpointId;
  forked_at: Timestamp;
}

export interface StoredCheckpoint {
  checkpoint_id: CheckpointId;
  task_id: TaskId;
  thread_id?: ThreadId;
}

const FORBIDDEN_CHECKPOINT_KEYS = new Set([
  'model_context',
  'hidden_reasoning',
  'driver_temp_cache',
  'unfinished_coroutine',
  'long_term_memory',
  'raw_llm_context',
]);

export function createCoordinatorCheckpoint(
  request: CoordinatorCheckpointRequest,
): CoordinatorCheckpoint {
  assertNoForbiddenCheckpointKeys(request);
  assertCheckpointTypeImplemented(request.checkpoint_type);

  return {
    checkpoint_id: createId('checkpoint'),
    thread_id: request.thread_id,
    ...(request.parent_checkpoint_id !== undefined
      ? { parent_checkpoint_id: request.parent_checkpoint_id }
      : {}),
    checkpoint_type: request.checkpoint_type,
    schema_version: request.schema_version ?? SCHEMA_VERSION,
    task_id: request.task_id,
    ...(request.run_id !== undefined ? { run_id: request.run_id } : {}),
    ...(request.agent_id !== undefined ? { agent_id: request.agent_id } : {}),
    trigger: request.trigger,
    message_thread: [...request.message_thread],
    scheduling: request.scheduling,
    se_domain_state: request.se_domain_state,
    mechanical_snapshot: request.mechanical_snapshot,
    semantic_handoff: request.semantic_handoff,
    ...(request.runtime_state !== undefined ? { runtime_state: request.runtime_state } : {}),
    ...(request.interrupt_state !== undefined ? { interrupt_state: request.interrupt_state } : {}),
    artifact_refs:
      request.artifact_refs ??
      (request.mechanical_snapshot.snapshot_commit
        ? { git_commit_hash: request.mechanical_snapshot.snapshot_commit }
        : {}),
    validity_status: 'valid',
    created_at: nowTimestamp(),
  };
}

function assertCheckpointTypeImplemented(type: CoordinatorCheckpointType): void {
  if (type === 'incremental') {
    throw new Error('Incremental checkpoint is not implemented yet');
  }
}

function assertNoForbiddenCheckpointKeys(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      assertNoForbiddenCheckpointKeys(item);
    }
    return;
  }

  if (value === null || typeof value !== 'object') {
    return;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    if (FORBIDDEN_CHECKPOINT_KEYS.has(key)) {
      throw new Error(`Checkpoint must not include forbidden key: ${key}`);
    }
    assertNoForbiddenCheckpointKeys(nestedValue);
  }
}

export class InMemoryCheckpointStore<TCheckpoint extends StoredCheckpoint = CoreCheckpoint> {
  private readonly checkpoints = new Map<CheckpointId, TCheckpoint>();
  private readonly checkpointIdsByThread = new Map<ThreadId, CheckpointId[]>();

  save(checkpoint: TCheckpoint): TCheckpoint {
    this.assertParentCheckpoint(checkpoint);
    this.checkpoints.set(checkpoint.checkpoint_id, checkpoint);
    if (checkpoint.thread_id !== undefined) {
      const existingIds = this.checkpointIdsByThread.get(checkpoint.thread_id) ?? [];
      this.checkpointIdsByThread.set(checkpoint.thread_id, [
        ...existingIds.filter((checkpointId) => checkpointId !== checkpoint.checkpoint_id),
        checkpoint.checkpoint_id,
      ]);
    }
    return checkpoint;
  }

  get(checkpointId: CheckpointId): TCheckpoint | undefined {
    return this.checkpoints.get(checkpointId);
  }

  list(): TCheckpoint[] {
    return [...this.checkpoints.values()];
  }

  getLatest(threadId: ThreadId): TCheckpoint | undefined {
    const checkpointIds = this.checkpointIdsByThread.get(threadId) ?? [];
    const checkpointId = checkpointIds.at(-1);
    return checkpointId ? this.checkpoints.get(checkpointId) : undefined;
  }

  listHistory(threadId: ThreadId, options?: CoordinatorCheckpointHistoryOptions): TCheckpoint[] {
    const checkpointIds = this.checkpointIdsByThread.get(threadId) ?? [];
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? checkpointIds.length;

    return checkpointIds
      .slice(offset, offset + limit)
      .map((checkpointId) => this.checkpoints.get(checkpointId))
      .filter((checkpoint): checkpoint is TCheckpoint => checkpoint !== undefined);
  }

  load(threadId: ThreadId, checkpointId?: CheckpointId): TCheckpoint | undefined {
    if (checkpointId === undefined) {
      return this.getLatest(threadId);
    }

    const checkpoint = this.checkpoints.get(checkpointId);
    return checkpoint?.thread_id === threadId ? checkpoint : undefined;
  }

  fork(
    _threadId: ThreadId,
    _checkpointId: CheckpointId,
    _newThreadId: ThreadId,
  ): CoordinatorCheckpointForkResult {
    throw new Error('checkpoint.fork is not implemented yet');
  }

  private assertParentCheckpoint(checkpoint: TCheckpoint): void {
    const parentCheckpointId = getParentCheckpointId(checkpoint);
    if (parentCheckpointId === undefined) {
      return;
    }

    const parent = this.checkpoints.get(parentCheckpointId);
    if (!parent) {
      throw new Error(`Parent checkpoint ${parentCheckpointId} was not found`);
    }
    if (
      checkpoint.thread_id !== undefined &&
      parent.thread_id !== undefined &&
      parent.thread_id !== checkpoint.thread_id
    ) {
      throw new Error('Parent checkpoint must belong to the same thread');
    }
  }
}

function getParentCheckpointId(checkpoint: StoredCheckpoint): CheckpointId | undefined {
  if (!('parent_checkpoint_id' in checkpoint)) {
    return undefined;
  }

  const parentCheckpointId = checkpoint.parent_checkpoint_id;
  return typeof parentCheckpointId === 'string' ? parentCheckpointId : undefined;
}
