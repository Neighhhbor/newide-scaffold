import type { GateResultId, SchemaVersion, Timestamp } from "../core";

export type GateDecision = "allow" | "deny" | "ask" | "defer";

export interface GateRequest {
  gate_id: string;
  gate_point: string;
  subject_id: string;
  priority: number;
  denying: boolean;
  timeout_ms: number;
  created_at: Timestamp;
  payload?: Record<string, unknown>;
  schema_version: SchemaVersion;
}

export interface GateResult {
  gate_result_id: GateResultId;
  gate_id: string;
  gate_point: string;
  subject_id: string;
  decision: GateDecision;
  reason: string;
  required_actions: string[];
  audit_ref: string;
  target_state: string;
  created_at: Timestamp;
  schema_version: SchemaVersion;
}

export interface GateRunner {
  readonly gate_id: string;
  run(request: GateRequest): Promise<GateResult>;
}
