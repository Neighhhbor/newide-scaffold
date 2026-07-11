import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, type ArtifactRef } from '../../src/core';
import type { AgentExecutionFacade, AgentExecutionRequest } from '../../src/memory';
import { SynthesisAgentCouncilProvider } from '../../src/council/providers/synthesis-agent-provider';

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
      { signal: controller.signal },
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
  });
});

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
