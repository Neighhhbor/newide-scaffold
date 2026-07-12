import type { ArtifactId, DriverRunResultId, SchemaVersion, TaskId, Timestamp } from './ids';

export type ArtifactType =
  | 'patch'
  | 'diff'
  | 'test_log'
  | 'review'
  | 'decision_packet'
  | 'checkpoint'
  | 'context'
  | 'transcript'
  | 'driver_result'
  | 'audit'
  | 'merge_authorization';

export interface ArtifactContent {
  kind: 'text' | 'file' | 'patch' | 'metadata';
  content_ref: string;
  target_path?: string;
  media_type?: string;
}

export interface ArtifactRef {
  artifact_id: ArtifactId;
  type: ArtifactType;
  uri: string;
  sha256?: string;
  producer_id: string;
  task_id?: TaskId;
  metadata?: Record<string, unknown>;
  content?: ArtifactContent;
  created_at: Timestamp;
  schema_version: SchemaVersion;
}

export interface DriverRunResultRef {
  driver_run_result_id: DriverRunResultId;
  uri: string;
  schema_version: SchemaVersion;
}
