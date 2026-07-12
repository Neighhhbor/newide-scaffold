/**
 * SynthesisAgentCouncilProvider
 *
 * Council 的真实 agent-backed MVP provider。它只依赖 B 方向 AgentExecutionFacade，
 * 不直接调用 A 方向 DriverRuntimeHandle。
 */
import { SCHEMA_VERSION, createId, nowTimestamp, type ArtifactRef } from '../../core';
import type { AgentExecutionFacade, AgentExecutionResult } from '../../memory';
import type {
  CouncilDecision,
  CouncilExecutionOptions,
  CouncilLifecycleEvent,
  CouncilOutput,
  CouncilProvider,
  CouncilRunResult,
  CouncilRoundInput,
  CouncilSynthesis,
  Proposal,
  Review,
} from '../contract';

export type CouncilRoleFailureCode =
  | 'COUNCIL_PROPOSAL_FAILED'
  | 'COUNCIL_REVIEW_FAILED'
  | 'COUNCIL_SYNTHESIS_FAILED';

type CouncilPhase = 'proposal' | 'review' | 'synthesis';

export class CouncilRoleExecutionError extends Error {
  readonly code: CouncilRoleFailureCode;
  readonly phase = 'council';

  constructor(
    readonly council_phase: CouncilPhase,
    readonly role_id: string,
    readonly agent_status: AgentExecutionResult['status'],
    readonly agent_run_id?: string,
    readonly driver_run_result_id?: string,
  ) {
    super(`Council ${council_phase} role failed`);
    this.name = 'CouncilRoleExecutionError';
    this.code = failureCode(council_phase);
  }

  get details(): Record<string, unknown> {
    return {
      phase: this.phase,
      council_phase: this.council_phase,
      role_id: this.role_id,
      agent_status: this.agent_status,
      ...(this.agent_run_id ? { agent_run_id: this.agent_run_id } : {}),
      ...(this.driver_run_result_id ? { driver_run_result_id: this.driver_run_result_id } : {}),
    };
  }
}

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
      'proposal',
      options,
    );
    const proposalA = buildProposal(input, proposerA);
    await emitLifecycle(options, completedProposalEvent(proposalA, proposerA));
    const proposerB = await this.runRole(
      input,
      executionRunId,
      'proposer_b',
      'Produce proposal B.',
      input.evidence_pack?.artifact_refs ?? [],
      'proposal',
      options,
    );
    const proposalB = buildProposal(input, proposerB);
    await emitLifecycle(options, completedProposalEvent(proposalB, proposerB));
    const generatedProposals = [proposalA, proposalB];
    const proposals = [...input.proposals, ...generatedProposals];
    const reviewer = await this.runRole(
      input,
      executionRunId,
      'reviewer',
      `Review proposals: ${proposals.map((proposal) => proposal.proposal_id).join(', ')}`,
      proposals.flatMap((proposal) => proposal.artifact_refs),
      'review',
      options,
    );
    const reviews = proposals.map((proposal) => buildReview(proposal, reviewer));
    await emitLifecycle(options, {
      type: 'council.review.completed',
      payload: {
        role_id: reviewer.role_id,
        agent_run_id: reviewer.agent_run_id,
        driver_run_result_id: reviewer.driver_run_result_id,
        proposal_ids: proposals.map((proposal) => proposal.proposal_id),
        review_ids: reviews.map((review) => review.review_id),
        artifact_refs: reviewer.artifact_refs.map((artifact) => artifact.artifact_id),
      },
    });
    const synthesizer = await this.runRole(
      input,
      executionRunId,
      'synthesizer',
      `Synthesize final candidate from proposals and reviews for: ${input.question}`,
      proposals.flatMap((proposal) => proposal.artifact_refs),
      'synthesis',
      options,
    );
    const synthesis = buildSynthesis(input, proposals, reviews, synthesizer);
    await emitLifecycle(options, {
      type: 'council.synthesis.completed',
      payload: {
        role_id: synthesizer.role_id,
        agent_run_id: synthesizer.agent_run_id,
        driver_run_result_id: synthesizer.driver_run_result_id,
        synthesis_id: synthesis.synthesis_id,
        artifact_refs: synthesis.artifact_refs,
      },
    });
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
    phase: CouncilPhase,
    options?: CouncilExecutionOptions,
  ): Promise<AgentExecutionResult> {
    let result: AgentExecutionResult;
    try {
      result = await this.agentExecutionFacade.runAgent(
        {
          task_id: input.task_id,
          run_id: executionRunId,
          role_id: roleId,
          instruction,
          input_artifact_refs: inputArtifactRefs,
          context_policy: 'council_synthesis_default',
          schema_version: SCHEMA_VERSION,
        },
        options?.signal ? { signal: options.signal } : undefined,
      );
    } catch (error) {
      if (options?.signal?.aborted) throw error;
      const failure = new CouncilRoleExecutionError(phase, roleId, 'failed');
      await emitFailureLifecycle(options, failure);
      throw failure;
    }
    options?.signal?.throwIfAborted();
    if (result.status !== 'completed') {
      const failure = new CouncilRoleExecutionError(
        phase,
        roleId,
        result.status,
        result.agent_run_id,
        result.driver_run_result_id,
      );
      await emitFailureLifecycle(options, failure);
      throw failure;
    }
    return result;
  }
}

function completedProposalEvent(
  proposal: Proposal,
  result: AgentExecutionResult,
): CouncilLifecycleEvent {
  return {
    type: 'council.proposal.completed',
    payload: {
      role_id: result.role_id,
      agent_run_id: result.agent_run_id,
      driver_run_result_id: result.driver_run_result_id,
      proposal_id: proposal.proposal_id,
      artifact_refs: proposal.artifact_refs,
    },
  };
}

function failedEvent(error: CouncilRoleExecutionError): CouncilLifecycleEvent {
  return { type: 'council.failed', payload: { code: error.code, ...error.details } };
}

async function emitLifecycle(
  options: CouncilExecutionOptions | undefined,
  event: CouncilLifecycleEvent,
): Promise<void> {
  await options?.onLifecycleEvent?.(event);
}

async function emitFailureLifecycle(
  options: CouncilExecutionOptions | undefined,
  failure: CouncilRoleExecutionError,
): Promise<void> {
  try {
    await emitLifecycle(options, failedEvent(failure));
  } catch {
    // Preserve the stable Council role error when its failure observer is unavailable.
  }
}

function failureCode(phase: CouncilPhase): CouncilRoleFailureCode {
  if (phase === 'proposal') return 'COUNCIL_PROPOSAL_FAILED';
  if (phase === 'review') return 'COUNCIL_REVIEW_FAILED';
  return 'COUNCIL_SYNTHESIS_FAILED';
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
