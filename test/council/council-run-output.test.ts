import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, nowTimestamp, type ArtifactRef } from '../../src/core';
import {
  buildCouncilRunOutputPaths,
  writeCouncilRunOutputs,
} from '../../src/council/council-run-output';
import type { CouncilRunResult } from '../../src/council';

const tempDirs: string[] = [];

describe('council run output', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('writes council proposals reviews synthesis decision and output files', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'council-run-output-'));
    tempDirs.push(tempDir);
    const paths = buildCouncilRunOutputPaths('run_001', tempDir);
    const result = createCouncilRunResult();

    const written = await writeCouncilRunOutputs({ paths, result });

    expect(written).toEqual(paths);
    await expect(readJson(paths.proposals_path)).resolves.toMatchObject([
      { proposal_id: 'proposal_001' },
    ]);
    await expect(readJson(paths.reviews_path)).resolves.toMatchObject([
      { review_id: 'review_001' },
    ]);
    await expect(readJson(paths.synthesis_path)).resolves.toMatchObject({
      synthesis_id: 'synthesis_001',
      artifact_refs: ['artifact_synthesis_001'],
    });
    await expect(readJson(paths.decision_path)).resolves.toMatchObject({
      decision_id: 'decision_001',
      selected_artifact_refs: ['artifact_synthesis_001'],
    });
    await expect(readJson(paths.output_path)).resolves.toMatchObject({
      output_id: 'output_001',
      selected_artifact_refs: ['artifact_synthesis_001'],
      can_create_merge_authorization: false,
    });
  });
});

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, 'utf-8'));
}

function createCouncilRunResult(): CouncilRunResult {
  const artifact = createArtifact('artifact_synthesis_001');
  return {
    council_run_id: 'council_run_001',
    run_id: 'run_001',
    task_id: 'task_001',
    proposals: [
      {
        proposal_id: 'proposal_001',
        run_id: 'run_001',
        task_id: 'task_001',
        agent_id: 'proposer_a',
        artifact_refs: ['artifact_proposal_001'],
        summary: 'proposal',
        claims: [],
        affected_paths: [],
        assumptions: [],
        known_risks: [],
        completion_evidence: [],
        created_at: nowTimestamp(),
        schema_version: SCHEMA_VERSION,
      },
    ],
    reviews: [
      {
        review_id: 'review_001',
        proposal_id: 'proposal_001',
        reviewer_id: 'reviewer',
        verdict: 'approve',
        reason: 'ok',
        created_at: nowTimestamp(),
        schema_version: SCHEMA_VERSION,
      },
    ],
    synthesis: {
      synthesis_id: 'synthesis_001',
      run_id: 'run_001',
      task_id: 'task_001',
      synthesizer_id: 'synthesizer',
      input_proposal_ids: ['proposal_001'],
      input_review_ids: ['review_001'],
      artifact_refs: [artifact.artifact_id],
      summary: 'synthesis',
      created_at: nowTimestamp(),
      schema_version: SCHEMA_VERSION,
    },
    decision: {
      decision_id: 'decision_001',
      run_id: 'run_001',
      task_id: 'task_001',
      decision_mode: 'advisory',
      selected_artifact_refs: [artifact.artifact_id],
      verdict: 'select',
      reason: 'selected',
      evidence_refs: ['synthesis_001'],
      can_create_merge_authorization: false,
      created_at: nowTimestamp(),
      schema_version: SCHEMA_VERSION,
    },
    output: {
      output_id: 'output_001',
      run_id: 'run_001',
      task_id: 'task_001',
      status: 'selected',
      decision_ref: 'decision_001',
      selected_artifact_refs: [artifact.artifact_id],
      generated_artifact_refs: [artifact],
      required_next_actions: ['post_council_gate'],
      blocked_by: [],
      can_create_merge_authorization: false,
      created_at: nowTimestamp(),
      schema_version: SCHEMA_VERSION,
    },
    generated_artifact_refs: [artifact],
    selected_artifact_refs: [artifact.artifact_id],
    created_at: nowTimestamp(),
    schema_version: SCHEMA_VERSION,
  };
}

function createArtifact(artifactId: string): ArtifactRef {
  return {
    artifact_id: artifactId,
    type: 'patch',
    uri: `artifact://patch/${artifactId}`,
    producer_id: 'synthesizer',
    task_id: 'task_001',
    created_at: nowTimestamp(),
    schema_version: SCHEMA_VERSION,
  };
}
