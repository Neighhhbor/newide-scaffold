import type {
  ArtifactId,
  CouncilDecisionId,
  DecisionId,
  GateResultId,
  RunId,
  SchemaVersion,
  TaskId,
  Timestamp
} from "./ids";

export interface Decision {
  decision_id: DecisionId;
  run_id: RunId;
  task_id: TaskId;
  verdict: "accepted" | "rejected" | "needs_revision" | "deferred";
  reason: string;
  evidence_refs: ArtifactId[];
  created_at: Timestamp;
  schema_version: SchemaVersion;
}

export interface MergeAuthorization {
  merge_authorization_id: string;
  run_id: RunId;
  task_id: TaskId;
  selected_artifact_refs: ArtifactId[];
  gate_result_refs: GateResultId[];
  council_decision_ref?: CouncilDecisionId;
  status: "authorized" | "blocked" | "revoked";
  reason?: string;
  created_at: Timestamp;
  schema_version: SchemaVersion;
}

export interface CouncilDecisionRef {
  council_decision_id: CouncilDecisionId;
  uri: string;
  schema_version: SchemaVersion;
}

export interface GateResultRef {
  gate_result_id: GateResultId;
  uri: string;
  decision: "allow" | "deny" | "ask" | "defer";
  schema_version: SchemaVersion;
}
