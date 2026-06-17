import type {
  ArtifactId,
  ContextPackId,
  MemoryRef,
  RoleProfileRef,
  SchemaVersion,
  TaskId,
  Timestamp,
} from '../core';

export interface ContextPack {
  context_pack_id: ContextPackId;
  task_id: TaskId;
  role_profile_ref: RoleProfileRef;
  memory_refs: MemoryRef[];
  artifact_refs: ArtifactId[];
  summary: string;
  created_at: Timestamp;
  schema_version: SchemaVersion;
}

export interface MemoryPolicy {
  include_persona: boolean;
  include_skills: boolean;
  include_recent_experience: boolean;
  max_memory_items: number;
}

export interface BuildContextPackInput {
  task_id: TaskId;
  role_profile_ref: RoleProfileRef;
  memory_refs?: MemoryRef[];
  artifact_refs?: ArtifactId[];
  summary_hint?: string;
}

export interface MemoryProvider {
  buildContextPack(input: BuildContextPackInput): Promise<ContextPack>;
}
