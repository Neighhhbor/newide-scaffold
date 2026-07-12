import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, nowTimestamp } from '../../src/core';
import {
  buildCouncilDecisionOutputPaths,
  writeCouncilDecisionOutput,
} from '../../src/council/council-decision-output';
import type { CouncilDecision } from '../../src/council';

const tempDirs: string[] = [];

describe('council decision output', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('builds stable council decision output paths under the run directory', () => {
    expect(buildCouncilDecisionOutputPaths('run_001')).toEqual({
      council_dir: '.newide/runs/run_001/council',
      decision_path: '.newide/runs/run_001/council/decision.json',
    });
  });

  it('writes a council decision JSON file and returns the written path', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'council-decision-output-'));
    tempDirs.push(tempDir);
    const paths = buildCouncilDecisionOutputPaths('run_001', tempDir);
    const decision: CouncilDecision = {
      decision_id: 'council_decision_001',
      run_id: 'run_001',
      task_id: 'task_001',
      decision_mode: 'advisory',
      selected_proposal_id: 'proposal_001',
      selected_artifact_refs: ['artifact_synthesis_001'],
      verdict: 'select',
      reason: 'Mock council selected a final candidate artifact.',
      evidence_refs: ['evidence_pack_001'],
      can_create_merge_authorization: false,
      created_at: nowTimestamp(),
      schema_version: SCHEMA_VERSION,
    };

    const result = await writeCouncilDecisionOutput({ paths, decision });

    expect(result).toEqual(paths);
    await expect(readJson(paths.decision_path)).resolves.toMatchObject({
      decision_id: 'council_decision_001',
      selected_artifact_refs: ['artifact_synthesis_001'],
      can_create_merge_authorization: false,
    });
  });
});

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, 'utf-8'));
}
