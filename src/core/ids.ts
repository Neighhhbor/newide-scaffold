export const SCHEMA_VERSION = 'v0' as const;

export type SchemaVersion = typeof SCHEMA_VERSION;
export type Timestamp = string;

export type TaskId = string;
export type RunId = string;
export type AgentId = string;
export type RoleId = string;
export type DriverId = string;
export type DriverSessionId = string;
export type EventId = string;
export type ArtifactId = string;
export type CheckpointId = string;
export type DecisionId = string;
export type MessageId = string;
export type ThreadId = string;
export type LeaseId = string;
export type MemoryId = string;
export type ContextPackId = string;
export type GateResultId = string;
export type CouncilDecisionId = string;
export type DriverRunResultId = string;

export interface Versioned {
  schema_version: SchemaVersion;
}

let sequence = 0;

export function nowTimestamp(): Timestamp {
  return new Date().toISOString();
}

export function createId(prefix: string): string {
  sequence += 1;
  return `${prefix}_${sequence.toString().padStart(4, '0')}`;
}
