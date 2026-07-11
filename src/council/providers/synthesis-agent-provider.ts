/**
 * SynthesisAgentCouncilProvider
 *
 * Council 的真实 agent-backed MVP provider。它只依赖 B 方向 AgentExecutionFacade，
 * 不直接调用 A 方向 DriverRuntimeHandle。
 */
import { SCHEMA_VERSION, createId, nowTimestamp, type ArtifactRef } from '../../core';
import type {
  AgentExecutionFacade,
  AgentExecutionOptions,
  AgentExecutionResult,
} from '../../memory';
import type {
  CouncilDecision,
  CouncilExecutionOptions,
  CouncilOutput,
  CouncilProvider,
  CouncilRunResult,
  CouncilRoundInput,
  CouncilSynthesis,
  Proposal,
  Review,
} from '../contract';

export interface SynthesisAgentCouncilProviderOptions {
  agentExecutionFacade: AgentExecutionFacade;
}

export class SynthesisAgentCouncilProvider implements CouncilProvider {
  private readonly agentExecutionFacade: AgentExecutionFacade;

  constructor(options: SynthesisAgentCouncilProviderOptions) {
    this.agentExecutionFacade = options.agentExecutionFacade;
  }

  async runCouncilRound(
    input: CouncilRoundInput,
    options?: CouncilExecutionOptions,
  ): Promise<CouncilRunResult> {
    const executionRunId = input.run_id ?? createId('run');
    const proposerA = await this.runRole(
      input,
      executionRunId,
      'proposer_a',
      'Produce proposal A.',
      input.evidence_pack?.artifact_refs ?? [],
      options,
    );
    const proposerB = await this.runRole(
      input,
      executionRunId,
      'proposer_b',
      'Produce proposal B.',
      input.evidence_pack?.artifact_refs ?? [],
      options,
    );
    const generatedProposals = [buildProposal(input, proposerA), buildProposal(input, proposerB)];
    const proposals = [...input.proposals, ...generatedProposals];
    const reviewer = await this.runRole(
      input,
      executionRunId,
      'reviewer',
      `Review proposals: ${proposals.map((proposal) => proposal.proposal_id).join(', ')}`,
      proposals.flatMap((proposal) => proposal.artifact_refs),
      options,
    );
    const reviews = proposals.map((proposal) => buildReview(proposal, reviewer));
    const synthesizer = await this.runRole(
      input,
      executionRunId,
      'synthesizer',
      `Synthesize final candidate from proposals and reviews for: ${input.question}`,
      proposals.flatMap((proposal) => proposal.artifact_refs),
      options,
    );
    const synthesis = buildSynthesis(input, proposals, reviews, synthesizer);
    const selectedArtifactRefs = synthesizer.artifact_refs.map((artifact) => artifact.artifact_id);
    const generatedArtifactRefs = [
      ...proposerA.artifact_refs,
      ...proposerB.artifact_refs,
      ...reviewer.artifact_refs,
      ...synthesizer.artifact_refs,
    ];
    const decision = buildDecision(input, synthesis, selectedArtifactRefs);

    return {
      council_run_id: createId('council_run'),
      ...(input.run_id ? { run_id: input.run_id } : {}),
      task_id: input.task_id,
      proposals,
      reviews,
      synthesis,
      decision,
      output: buildOutput(input, decision, generatedArtifactRefs),
      generated_artifact_refs: generatedArtifactRefs,
      selected_artifact_refs: selectedArtifactRefs,
      created_at: nowTimestamp(),
      schema_version: SCHEMA_VERSION,
    };
  }

  private async runRole(
    input: CouncilRoundInput,
    executionRunId: string,
    roleId: string,
    instruction: string,
    inputArtifactRefs: string[] = input.evidence_pack?.artifact_refs ?? [],
    options?: AgentExecutionOptions,
  ): Promise<AgentExecutionResult> {
    return this.agentExecutionFacade.runAgent(
      {
        task_id: input.task_id,
        run_id: executionRunId,
        role_id: roleId,
        instruction,
        input_artifact_refs: inputArtifactRefs,
        context_policy: 'council_synthesis_default',
        schema_version: SCHEMA_VERSION,
      },
      options,
    );
  }
}

function buildProposal(input: CouncilRoundInput, result: AgentExecutionResult): Proposal {
  return {
    proposal_id: createId('proposal'),
    ...(input.run_id ? { run_id: input.run_id } : {}),
    task_id: input.task_id,
    agent_id: result.role_id,
    artifact_refs: result.artifact_refs.map((artifact) => artifact.artifact_id),
    summary: `${result.role_id} generated a council proposal.`,
    claims: [],
    affected_paths: [],
    assumptions: [],
    known_risks: [],
    completion_evidence: [result.driver_run_result_id],
    created_at: nowTimestamp(),
    schema_version: SCHEMA_VERSION,
  };
}

function buildReview(proposal: Proposal, result: AgentExecutionResult): Review {
  return {
    review_id: createId('review'),
    proposal_id: proposal.proposal_id,
    reviewer_id: result.role_id,
    verdict: result.status === 'completed' ? 'approve' : 'needs_revision',
    reason: `${result.role_id} reviewed proposal ${proposal.proposal_id}.`,
    created_at: nowTimestamp(),
    schema_version: SCHEMA_VERSION,
  };
}

function buildSynthesis(
  input: CouncilRoundInput,
  proposals: Proposal[],
  reviews: Review[],
  result: AgentExecutionResult,
): CouncilSynthesis {
  return {
    synthesis_id: createId('council_synthesis'),
    ...(input.run_id ? { run_id: input.run_id } : {}),
    task_id: input.task_id,
    synthesizer_id: result.role_id,
    input_proposal_ids: proposals.map((proposal) => proposal.proposal_id),
    input_review_ids: reviews.map((review) => review.review_id),
    artifact_refs: result.artifact_refs.map((artifact) => artifact.artifact_id),
    summary: 'Synthesis agent produced a final candidate artifact.',
    created_at: nowTimestamp(),
    schema_version: SCHEMA_VERSION,
  };
}

function buildDecision(
  input: CouncilRoundInput,
  synthesis: CouncilSynthesis,
  selectedArtifactRefs: string[],
): CouncilDecision {
  const hasSelection = selectedArtifactRefs.length > 0;
  return {
    decision_id: createId('council_decision'),
    ...(input.run_id ? { run_id: input.run_id } : {}),
    task_id: input.task_id,
    decision_mode: input.decision_mode,
    selected_artifact_refs: selectedArtifactRefs,
    verdict: hasSelection ? 'select' : 'needs_human',
    reason: hasSelection
      ? 'Synthesis agent produced the selected final candidate artifact.'
      : 'Synthesis agent did not produce a selectable artifact.',
    evidence_refs: [
      synthesis.synthesis_id,
      ...(input.evidence_pack ? [input.evidence_pack.evidence_pack_id] : []),
    ],
    can_create_merge_authorization: false,
    created_at: nowTimestamp(),
    schema_version: SCHEMA_VERSION,
  };
}

function buildOutput(
  input: CouncilRoundInput,
  decision: CouncilDecision,
  generatedArtifactRefs: ArtifactRef[],
): CouncilOutput {
  return {
    output_id: createId('council_output'),
    ...(input.run_id ? { run_id: input.run_id } : {}),
    task_id: input.task_id,
    status: decision.verdict === 'select' ? 'selected' : 'needs_human',
    decision_ref: decision.decision_id,
    selected_artifact_refs: decision.selected_artifact_refs,
    generated_artifact_refs: generatedArtifactRefs,
    required_next_actions: decision.verdict === 'select' ? ['post_council_gate'] : ['human_review'],
    blocked_by: decision.verdict === 'select' ? [] : ['council_no_synthesis_artifact'],
    can_create_merge_authorization: false,
    created_at: nowTimestamp(),
    schema_version: SCHEMA_VERSION,
  };
}
