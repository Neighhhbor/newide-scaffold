/**
 * Council decision output helper.
 *
 * This file only owns `.newide/runs/<run_id>/council/decision.json` paths and writing.
 * It does not create Council decisions, call providers, or know Council internals.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { RunId } from '../core';
import type { CouncilDecision } from './contract';

export interface CouncilDecisionOutputPaths {
  council_dir: string;
  decision_path: string;
}

export interface WriteCouncilDecisionOutputInput {
  paths: CouncilDecisionOutputPaths;
  decision: CouncilDecision;
}

export function buildCouncilDecisionOutputPaths(
  runId: RunId,
  runsRoot = '.newide/runs',
): CouncilDecisionOutputPaths {
  const councilDir = path.join(runsRoot, runId, 'council');
  return {
    council_dir: councilDir,
    decision_path: path.join(councilDir, 'decision.json'),
  };
}

export async function writeCouncilDecisionOutput(
  input: WriteCouncilDecisionOutputInput,
): Promise<CouncilDecisionOutputPaths> {
  await fs.mkdir(input.paths.council_dir, { recursive: true });
  await fs.writeFile(input.paths.decision_path, JSON.stringify(input.decision, null, 2), 'utf-8');
  return input.paths;
}
