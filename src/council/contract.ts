import type { ArtifactId, RunId, SchemaVersion, TaskId, Timestamp } from '../core';

export interface Proposal {
  proposal_id: string;
  run_id: RunId;
  task_id: TaskId;
  artifact_refs: ArtifactId[];
  summary: string;
  created_at: Timestamp;
  schema_version: SchemaVersion;
}

export interface Review {
  review_id: string;
  proposal_id: string;
  reviewer_id: string;
  verdict: 'approve' | 'reject' | 'needs_revision';
  reason: string;
  created_at: Timestamp;
  schema_version: SchemaVersion;
}

export interface EvidencePack {
  evidence_pack_id: string;
  context_pack_ref: string;
  artifact_refs: ArtifactId[];
  gate_result_refs: string[];
  created_at: Timestamp;
  schema_version: SchemaVersion;
}

export interface CouncilDecision {
  decision_id: string;
  run_id: RunId;
  task_id: TaskId;
  selected_proposal_id?: string;
  verdict: 'accept' | 'reject' | 'defer';
  reason: string;
  evidence_refs: string[];
  created_at: Timestamp;
  schema_version: SchemaVersion;
}

export interface CouncilRoundInput {
  run_id: RunId;
  task_id: TaskId;
  proposals: Proposal[];
  reviews?: Review[];
  evidence_pack: EvidencePack;
}

export interface CouncilProvider {
  runCouncilRound(input: CouncilRoundInput): Promise<CouncilDecision>;
}

export async function runCouncilRound(
  provider: CouncilProvider,
  input: CouncilRoundInput,
): Promise<CouncilDecision> {
  return provider.runCouncilRound(input);
}
