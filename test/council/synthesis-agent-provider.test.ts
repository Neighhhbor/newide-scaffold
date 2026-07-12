import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, type ArtifactRef } from '../../src/core';
import type {
  AgentExecutionFacade,
  AgentExecutionRequest,
} from '../../src/protocol/agent-execution';
import { SynthesisAgentCouncilProvider } from '../../src/council/providers/synthesis-agent-provider';
import type { CouncilRoleExecutionError } from '../../src/council/providers/synthesis-agent-provider';

describe('SynthesisAgentCouncilProvider', () => {
  it('runs proposer, reviewer, and synthesizer roles through AgentExecutionFacade', async () => {
    const requests: AgentExecutionRequest[] = [];
    const signals: Array<AbortSignal | undefined> = [];
    const agentExecutionFacade: AgentExecutionFacade = {
      async runAgent(input, options) {
        requests.push(input);
        signals.push(options?.signal);
        return {
          agent_run_id: `agent_run_${input.role_id}`,
          role_id: input.role_id,
          context_pack_ref: `context_${input.role_id}`,
          driver_run_result_id: `driver_result_${input.role_id}`,
          artifact_refs: [createArtifact(`artifact_${input.role_id}`, input.role_id)],
          transcript_ref: createArtifact(
            `transcript_${input.role_id}`,
            input.role_id,
            'transcript',
          ),
          diagnostics: {
            driver_id: `driver_${input.role_id}`,
          },
          status: 'completed',
          created_at: '2026-07-07T00:00:00.000Z',
          schema_version: SCHEMA_VERSION,
        };
      },
    };
    const provider = new SynthesisAgentCouncilProvider({ agentExecutionFacade });
    const controller = new AbortController();
    const lifecycleEvents: string[] = [];

    const result = await provider.runCouncilRound(
      {
        run_id: 'run_001',
        task_id: 'task_001',
        trigger: 'manual',
        decision_mode: 'advisory',
        question: 'Select a final implementation candidate.',
        proposals: [],
        evidence_pack: {
          evidence_pack_id: 'evidence_pack_001',
          task_id: 'task_001',
          artifact_refs: [],
          gate_result_refs: [],
          summary: 'evidence',
          created_at: '2026-07-07T00:00:00.000Z',
          schema_version: SCHEMA_VERSION,
        },
        schema_version: SCHEMA_VERSION,
      },
      {
        signal: controller.signal,
        onLifecycleEvent: (event) => lifecycleEvents.push(event.type),
      },
    );

    expect(requests.map((request) => request.role_id)).toEqual([
      'proposer_a',
      'proposer_b',
      'reviewer',
      'synthesizer',
    ]);
    expect(signals).toEqual(Array(4).fill(controller.signal));
    expect(result.proposals).toHaveLength(2);
    expect(result.reviews).toHaveLength(2);
    expect(result.synthesis).toMatchObject({
      synthesizer_id: 'synthesizer',
      artifact_refs: ['artifact_synthesizer'],
    });
    expect(result.decision).toMatchObject({
      verdict: 'select',
      selected_artifact_refs: ['artifact_synthesizer'],
      can_create_merge_authorization: false,
    });
    expect(result.generated_artifact_refs.map((artifact) => artifact.artifact_id)).toContain(
      'artifact_synthesizer',
    );
    expect(result.output).toMatchObject({
      status: 'selected',
      selected_artifact_refs: ['artifact_synthesizer'],
      can_create_merge_authorization: false,
    });
    expect(lifecycleEvents).toEqual([
      'council.proposal.completed',
      'council.proposal.completed',
      'council.review.completed',
      'council.synthesis.completed',
    ]);
  });

  it.each([
    ['proposer_a', 'COUNCIL_PROPOSAL_FAILED'],
    ['proposer_b', 'COUNCIL_PROPOSAL_FAILED'],
    ['reviewer', 'COUNCIL_REVIEW_FAILED'],
    ['synthesizer', 'COUNCIL_SYNTHESIS_FAILED'],
  ] as const)(
    'fails the council round with a stable error when %s fails',
    async (failedRole, expectedCode) => {
      const requests: string[] = [];
      const lifecycleEvents: Array<{ type: string; payload: Record<string, unknown> }> = [];
      const agentExecutionFacade: AgentExecutionFacade = {
        async runAgent(input) {
          requests.push(input.role_id);
          return {
            agent_run_id: `agent_run_${input.role_id}`,
            role_id: input.role_id,
            context_pack_ref: `context_${input.role_id}`,
            driver_run_result_id: `driver_result_${input.role_id}`,
            artifact_refs:
              input.role_id === failedRole
                ? []
                : [createArtifact(`artifact_${input.role_id}`, input.role_id)],
            transcript_ref: createArtifact(
              `transcript_${input.role_id}`,
              input.role_id,
              'transcript',
            ),
            diagnostics: { driver_id: `driver_${input.role_id}` },
            status: input.role_id === failedRole ? 'failed' : 'completed',
            created_at: '2026-07-07T00:00:00.000Z',
            schema_version: SCHEMA_VERSION,
          };
        },
      };
      const provider = new SynthesisAgentCouncilProvider({ agentExecutionFacade });

      const failure = provider.runCouncilRound(
        {
          run_id: 'run_failed_role',
          task_id: 'task_failed_role',
          trigger: 'manual',
          decision_mode: 'advisory',
          question: 'Fail one Council role.',
          proposals: [],
          schema_version: SCHEMA_VERSION,
        },
        { onLifecycleEvent: (event) => lifecycleEvents.push(event) },
      );
      await expect(failure).rejects.toMatchObject<Partial<CouncilRoleExecutionError>>({
        code: expectedCode,
        role_id: failedRole,
        agent_status: 'failed',
      });
      expect(requests).toEqual(
        ['proposer_a', 'proposer_b', 'reviewer', 'synthesizer'].slice(
          0,
          ['proposer_a', 'proposer_b', 'reviewer', 'synthesizer'].indexOf(failedRole) + 1,
        ),
      );
      expect(lifecycleEvents.at(-1)).toMatchObject({
        type: 'council.failed',
        payload: { code: expectedCode, role_id: failedRole, agent_status: 'failed' },
      });
    },
  );

  it('preserves cancellation without publishing council.failed', async () => {
    const controller = new AbortController();
    const lifecycleEvents: string[] = [];
    const agentExecutionFacade: AgentExecutionFacade = {
      async runAgent(input) {
        controller.abort(new Error('cancelled by user'));
        return {
          agent_run_id: `agent_run_${input.role_id}`,
          role_id: input.role_id,
          context_pack_ref: `context_${input.role_id}`,
          driver_run_result_id: `driver_result_${input.role_id}`,
          artifact_refs: [],
          transcript_ref: createArtifact(
            `transcript_${input.role_id}`,
            input.role_id,
            'transcript',
          ),
          diagnostics: { driver_id: `driver_${input.role_id}` },
          status: 'cancelled',
          created_at: '2026-07-07T00:00:00.000Z',
          schema_version: SCHEMA_VERSION,
        };
      },
    };
    const provider = new SynthesisAgentCouncilProvider({ agentExecutionFacade });

    await expect(
      provider.runCouncilRound(
        {
          run_id: 'run_cancelled',
          task_id: 'task_cancelled',
          trigger: 'manual',
          decision_mode: 'advisory',
          question: 'Cancel Council.',
          proposals: [],
          schema_version: SCHEMA_VERSION,
        },
        {
          signal: controller.signal,
          onLifecycleEvent: (event) => lifecycleEvents.push(event.type),
        },
      ),
    ).rejects.toThrow('cancelled by user');
    expect(lifecycleEvents).not.toContain('council.failed');
  });

  it('preserves the typed role error when council.failed publication fails', async () => {
    const failedProvider = new SynthesisAgentCouncilProvider({
      agentExecutionFacade: createFacade('proposer_a'),
    });
    await expect(
      failedProvider.runCouncilRound(baseInput(), {
        onLifecycleEvent: () => {
          throw new Error('observer unavailable');
        },
      }),
    ).rejects.toMatchObject({
      code: 'COUNCIL_PROPOSAL_FAILED',
      role_id: 'proposer_a',
    });
  });
});

function baseInput() {
  return {
    run_id: 'run_observer',
    task_id: 'task_observer',
    trigger: 'manual' as const,
    decision_mode: 'advisory' as const,
    question: 'Observe Council.',
    proposals: [],
    schema_version: SCHEMA_VERSION,
  };
}

function createFacade(failedRole?: string): AgentExecutionFacade {
  return {
    async runAgent(input) {
      const failed = input.role_id === failedRole;
      return {
        agent_run_id: `agent_run_${input.role_id}`,
        role_id: input.role_id,
        context_pack_ref: `context_${input.role_id}`,
        driver_run_result_id: `driver_result_${input.role_id}`,
        artifact_refs: failed ? [] : [createArtifact(`artifact_${input.role_id}`, input.role_id)],
        transcript_ref: createArtifact(`transcript_${input.role_id}`, input.role_id, 'transcript'),
        diagnostics: { driver_id: `driver_${input.role_id}` },
        status: failed ? ('failed' as const) : ('completed' as const),
        created_at: '2026-07-07T00:00:00.000Z',
        schema_version: SCHEMA_VERSION,
      };
    },
  };
}

function createArtifact(
  artifactId: string,
  roleId: string,
  type: ArtifactRef['type'] = 'patch',
): ArtifactRef {
  return {
    artifact_id: artifactId,
    type,
    uri: `artifact://${type}/${artifactId}`,
    producer_id: roleId,
    task_id: 'task_001',
    created_at: '2026-07-07T00:00:00.000Z',
    schema_version: SCHEMA_VERSION,
  };
}
