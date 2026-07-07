import { SCHEMA_VERSION, createId, nowTimestamp } from '../core';
import type {
  CouncilDecision,
  CouncilProvider,
  CouncilRoundInput,
  ProposalComparisonSummary,
} from './contract';

export class MockCouncil implements CouncilProvider {
  async runCouncilRound(input: CouncilRoundInput): Promise<CouncilDecision> {
    const selectedProposal = input.proposals[0];
    const comparison = buildComparisonSummary(input, selectedProposal?.proposal_id);

    return {
      decision_id: createId('council_decision'),
      ...(input.run_id ? { run_id: input.run_id } : {}),
      task_id: input.task_id,
      ...(selectedProposal ? { selected_proposal_id: selectedProposal.proposal_id } : {}),
      decision_mode: input.decision_mode,
      verdict: selectedProposal ? 'select' : 'needs_human',
      reason: selectedProposal
        ? 'Mock council selected the first proposal for v0 flow validation.'
        : 'Mock council requires human review because no proposal was provided.',
      evidence_refs: [
        ...(input.evidence_pack ? [input.evidence_pack.evidence_pack_id] : []),
        ...(input.evidence_pack?.artifact_refs ?? []),
        ...(input.evidence_pack?.gate_result_refs ?? []),
      ],
      comparison_ref: comparison.comparison_id,
      can_create_merge_authorization: false,
      created_at: nowTimestamp(),
      schema_version: SCHEMA_VERSION,
    };
  }
}

function buildComparisonSummary(
  input: CouncilRoundInput,
  selectedProposalId?: string,
): ProposalComparisonSummary {
  return {
    comparison_id: createId('proposal_comparison'),
    task_id: input.task_id,
    proposal_ids: input.proposals.map((proposal) => proposal.proposal_id),
    ...(selectedProposalId ? { selected_proposal_id: selectedProposalId } : {}),
    verdict: selectedProposalId ? 'select' : 'needs_human',
    reason: selectedProposalId
      ? 'Mock comparison selects the first proposal.'
      : 'Mock comparison has no proposal to select.',
    evidence_refs: input.evidence_pack
      ? [
          input.evidence_pack.evidence_pack_id,
          ...input.evidence_pack.artifact_refs,
          ...input.evidence_pack.gate_result_refs,
        ]
      : [],
    risk_signals: [],
    created_at: nowTimestamp(),
    schema_version: SCHEMA_VERSION,
  };
}
