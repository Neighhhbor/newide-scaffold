import type {
  AgentId,
  DriverId,
  DriverSessionId,
  RunId,
  SchemaVersion,
  TaskId,
  Timestamp,
} from './ids';

export type RunStatus =
  | 'created'
  | 'running'
  | 'waiting_gate'
  | 'waiting_council'
  | 'merging'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface Run {
  run_id: RunId;
  task_id: TaskId;
  status: RunStatus;
  created_at: Timestamp;
  updated_at: Timestamp;
  schema_version: SchemaVersion;
}

export interface AgentSession {
  agent_id: AgentId;
  role_id?: string;
  driver_id: DriverId;
  session_id: DriverSessionId;
  run_id: RunId;
  task_id: TaskId;
  status: 'starting' | 'running' | 'interrupted' | 'closed' | 'failed';
  created_at: Timestamp;
  updated_at: Timestamp;
  schema_version: SchemaVersion;
}
