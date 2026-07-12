import { describe, it, expect } from 'vitest';
import {
  ArtifactSelector,
  createArtifactSelector,
  type ArtifactSelectionInput,
} from '../../src/coordinator/artifact-finalizer';
import { MockCouncil } from '../../src/coordinator/../council';
import { SCHEMA_VERSION, createId, nowTimestamp, type ArtifactRef } from '../../src/core';
import type { DriverRunResult } from '../../src/driver';
import type { GateResult } from '../../src/gate';
import type { CouncilProvider, EvidencePack } from '../../src/council';

describe('ArtifactSelector', () => {
  const createMockDriverResult = (
    status: 'succeeded' | 'failed' = 'succeeded',
  ): DriverRunResult => {
    const artifact: ArtifactRef = {
      artifact_id: createId('artifact'),
      type: 'patch',
      uri: 'artifact://patch/test',
      producer_id: 'mock-driver',
      task_id: 'task-1',
      metadata: { content: 'mock patch content' },
      created_at: nowTimestamp(),
      schema_version: SCHEMA_VERSION,
    };

    return {
      driver_run_result_id: createId('driver_result'),
      session_id: 'session-1',
      status,
      artifacts: [artifact],
      transcript_ref: {
        artifact_id: createId('artifact'),
        type: 'transcript',
        uri: 'artifact://transcript/test',
        producer_id: 'mock-driver',
        created_at: nowTimestamp(),
        schema_version: SCHEMA_VERSION,
      },
      tool_events: [],
      diagnostics: {
        driver_id: 'mock-driver',
        duration_ms: 100,
        notes: [],
      },
      created_at: nowTimestamp(),
      schema_version: SCHEMA_VERSION,
    };
  };

  const createMockGateResult = (decision: 'allow' | 'deny' = 'allow'): GateResult => ({
    gate_result_id: createId('gate_result'),
    gate_point: 'task.completed',
    gate_id: 'test-gate',
    request_id: createId('gate_request'),
    subject_id: 'task-1',
    decision,
    reason: `Gate ${decision}`,
    required_actions: [],
    target_state: decision === 'allow' ? 'reviewing' : 'blocked',
    created_at: nowTimestamp(),
    schema_version: SCHEMA_VERSION,
  });

  const createMockEvidencePack = (): EvidencePack => ({
    evidence_pack_id: createId('evidence_pack'),
    task_id: 'task-1',
    context_pack_ref: 'context-1',
    artifact_refs: ['artifact-1'],
    gate_result_refs: ['gate-result-1'],
    summary: 'Mock evidence pack for artifact selection tests',
    created_at: nowTimestamp(),
    schema_version: SCHEMA_VERSION,
  });

  describe('single_agent mode', () => {
    it('should select first artifact when driver succeeded and gates allow', async () => {
      const selector = createArtifactSelector('single_agent');

      const input: ArtifactSelectionInput = {
        run_id: 'run-1',
        task_id: 'task-1',
        driver_result: createMockDriverResult('succeeded'),
        gate_results: [createMockGateResult('allow')],
      };

      const result = await selector.selectArtifacts(input);

      expect(result.mode).toBe('single_agent');
      expect(result.selected_artifacts).toHaveLength(1);
      expect(result.selected_artifacts[0]?.type).toBe('patch');
      expect(result.metadata.driver_status).toBe('succeeded');
      expect(result.metadata.gates_passed).toBe(true);
      expect(result.reason).toContain('direct selection');
    });

    it('should not select artifact when driver failed', async () => {
      const selector = createArtifactSelector('single_agent');

      const input: ArtifactSelectionInput = {
        run_id: 'run-1',
        task_id: 'task-1',
        driver_result: createMockDriverResult('failed'),
        gate_results: [createMockGateResult('allow')],
      };

      const result = await selector.selectArtifacts(input);

      expect(result.mode).toBe('single_agent');
      expect(result.selected_artifacts).toHaveLength(0);
      expect(result.metadata.driver_status).toBe('failed');
      expect(result.reason).toContain('no artifact selected');
    });

    it('should not select artifact when gates deny', async () => {
      const selector = createArtifactSelector('single_agent');

      const input: ArtifactSelectionInput = {
        run_id: 'run-1',
        task_id: 'task-1',
        driver_result: createMockDriverResult('succeeded'),
        gate_results: [createMockGateResult('deny')],
      };

      const result = await selector.selectArtifacts(input);

      expect(result.mode).toBe('single_agent');
      expect(result.selected_artifacts).toHaveLength(0);
      expect(result.metadata.gates_passed).toBe(false);
    });

    it('should not select artifact when driver has no artifacts', async () => {
      const selector = createArtifactSelector('single_agent');

      const driverResult = createMockDriverResult('succeeded');
      driverResult.artifacts = [];

      const input: ArtifactSelectionInput = {
        run_id: 'run-1',
        task_id: 'task-1',
        driver_result: driverResult,
        gate_results: [createMockGateResult('allow')],
      };

      const result = await selector.selectArtifacts(input);

      expect(result.selected_artifacts).toHaveLength(0);
    });
  });

  describe('council mode', () => {
    it('should select artifact via MockCouncil when proposal accepted', async () => {
      const selector = createArtifactSelector('council', new MockCouncil());

      const input: ArtifactSelectionInput = {
        run_id: 'run-1',
        task_id: 'task-1',
        driver_result: createMockDriverResult('succeeded'),
        gate_results: [createMockGateResult('allow')],
        evidence_pack: createMockEvidencePack(),
      };

      const result = await selector.selectArtifacts(input);

      expect(result.mode).toBe('council');
      expect(result.selected_artifacts).toHaveLength(1);
      expect(result.metadata.council_decision_id).toBeDefined();
      expect(result.metadata.decision_mode).toBe('advisory');
      expect(result.metadata.proposal_id).toBeDefined();
      expect(result.metadata.verdict).toBe('select');
      expect(result.metadata.can_create_merge_authorization).toBe(false);
      expect(result.council_decision).toMatchObject({
        task_id: 'task-1',
        decision_mode: 'advisory',
        verdict: 'select',
        can_create_merge_authorization: false,
      });
    });

    it('should not select artifact when no artifacts available', async () => {
      const selector = createArtifactSelector('council', new MockCouncil());

      const driverResult = createMockDriverResult('succeeded');
      driverResult.artifacts = []; // No artifacts available

      const input: ArtifactSelectionInput = {
        run_id: 'run-1',
        task_id: 'task-1',
        driver_result: driverResult,
        gate_results: [createMockGateResult('allow')],
        evidence_pack: createMockEvidencePack(),
      };

      const result = await selector.selectArtifacts(input);

      expect(result.mode).toBe('council');
      expect(result.selected_artifacts).toHaveLength(0);
      // MockCouncil can select the proposal, but there is no driver artifact to materialize.
      expect(result.metadata.verdict).toBe('select');
    });

    it('should select a council-generated artifact when decision points to it', async () => {
      const synthesisArtifact: ArtifactRef = {
        artifact_id: 'artifact_synthesis_001',
        type: 'patch',
        uri: 'artifact://patch/synthesis',
        producer_id: 'synthesizer',
        task_id: 'task-1',
        created_at: nowTimestamp(),
        schema_version: SCHEMA_VERSION,
      };
      const councilProvider: CouncilProvider = {
        async runCouncilRound(input) {
          const decision = {
            decision_id: 'council_decision_001',
            run_id: input.run_id,
            task_id: input.task_id,
            decision_mode: input.decision_mode,
            selected_artifact_refs: [synthesisArtifact.artifact_id],
            verdict: 'select' as const,
            reason: 'Selected synthesis artifact.',
            evidence_refs: [],
            can_create_merge_authorization: false,
            created_at: nowTimestamp(),
            schema_version: SCHEMA_VERSION,
          };

          return {
            council_run_id: 'council_run_001',
            run_id: input.run_id,
            task_id: input.task_id,
            proposals: input.proposals,
            reviews: [],
            decision,
            generated_artifact_refs: [synthesisArtifact],
            selected_artifact_refs: [synthesisArtifact.artifact_id],
            created_at: nowTimestamp(),
            schema_version: SCHEMA_VERSION,
          };
        },
      };
      const selector = createArtifactSelector('council', councilProvider);

      const result = await selector.selectArtifacts({
        run_id: 'run-1',
        task_id: 'task-1',
        driver_result: createMockDriverResult('succeeded'),
        gate_results: [createMockGateResult('allow')],
        evidence_pack: createMockEvidencePack(),
      });

      expect(result.selected_artifacts).toEqual([synthesisArtifact]);
      expect(result.metadata.generated_artifact_refs).toEqual(['artifact_synthesis_001']);
    });

    it('should throw when councilProvider is missing in council mode', async () => {
      const selector = new ArtifactSelector({ mode: 'council' });

      const input: ArtifactSelectionInput = {
        run_id: 'run-1',
        task_id: 'task-1',
        driver_result: createMockDriverResult('succeeded'),
        gate_results: [createMockGateResult('allow')],
        evidence_pack: createMockEvidencePack(),
      };

      await expect(selector.selectArtifacts(input)).rejects.toThrow('councilProvider is required');
    });

    it('should throw when evidence_pack is missing in council mode', async () => {
      const selector = createArtifactSelector('council', new MockCouncil());

      const input: ArtifactSelectionInput = {
        run_id: 'run-1',
        task_id: 'task-1',
        driver_result: createMockDriverResult('succeeded'),
        gate_results: [createMockGateResult('allow')],
        // evidence_pack is missing
      };

      await expect(selector.selectArtifacts(input)).rejects.toThrow('evidence_pack is required');
    });
  });

  describe('factory function', () => {
    it('should create single_agent selector by default', () => {
      const selector = createArtifactSelector();
      expect(selector).toBeInstanceOf(ArtifactSelector);
    });

    it('should create council selector with MockCouncil when mode is council', () => {
      const selector = createArtifactSelector('council');
      expect(selector).toBeInstanceOf(ArtifactSelector);
    });
  });

  describe('output compatibility', () => {
    it('should produce same structure for single_agent and council modes', async () => {
      const singleAgentSelector = createArtifactSelector('single_agent');
      const councilSelector = createArtifactSelector('council', new MockCouncil());

      const input: ArtifactSelectionInput = {
        run_id: 'run-1',
        task_id: 'task-1',
        driver_result: createMockDriverResult('succeeded'),
        gate_results: [createMockGateResult('allow')],
        evidence_pack: createMockEvidencePack(),
      };

      const singleResult = await singleAgentSelector.selectArtifacts(input);
      const councilResult = await councilSelector.selectArtifacts(input);

      // Both should have same structure
      expect(singleResult.selection_id).toBeDefined();
      expect(councilResult.selection_id).toBeDefined();
      expect(singleResult.run_id).toBe(councilResult.run_id);
      expect(singleResult.task_id).toBe(councilResult.task_id);
      expect(singleResult.schema_version).toBe(councilResult.schema_version);

      // Both should select the same artifact (MockCouncil accepts first proposal)
      expect(singleResult.selected_artifacts).toHaveLength(1);
      expect(councilResult.selected_artifacts).toHaveLength(1);
      expect(singleResult.selected_artifacts[0]?.artifact_id).toBe(
        councilResult.selected_artifacts[0]?.artifact_id,
      );
    });
  });
});
