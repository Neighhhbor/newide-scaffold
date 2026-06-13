import { SCHEMA_VERSION, createId, nowTimestamp } from "../core";
import type { CouncilDecision, CouncilProvider, CouncilRoundInput } from "./contract";

export class MockCouncil implements CouncilProvider {
  async runCouncilRound(input: CouncilRoundInput): Promise<CouncilDecision> {
    const selectedProposal = input.proposals[0];

    return {
      decision_id: createId("council_decision"),
      run_id: input.run_id,
      task_id: input.task_id,
      ...(selectedProposal ? { selected_proposal_id: selectedProposal.proposal_id } : {}),
      verdict: selectedProposal ? "accept" : "defer",
      reason: selectedProposal
        ? "Mock council selected the first proposal for v0 flow validation."
        : "Mock council deferred because no proposal was provided.",
      evidence_refs: [
        input.evidence_pack.evidence_pack_id,
        ...input.evidence_pack.artifact_refs,
        ...input.evidence_pack.gate_result_refs
      ],
      created_at: nowTimestamp(),
      schema_version: SCHEMA_VERSION
    };
  }
}
