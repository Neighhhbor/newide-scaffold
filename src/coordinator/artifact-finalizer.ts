import {
  SCHEMA_VERSION,
  createId,
  nowTimestamp,
  type ArtifactRef,
  type RunId,
  type TaskId,
} from '../core';
import type { DriverRunResult } from '../driver';
import type { GateResult } from '../gate';
import { MockCouncil, type CouncilProvider, type EvidencePack, type Proposal } from '../council';

export type SelectionMode = 'single_agent' | 'council';

export interface ArtifactSelectionResult {
  selection_id: string;
  run_id: RunId;
  task_id: TaskId;
  mode: SelectionMode;
  selected_artifacts: ArtifactRef[];
  reason: string;
  metadata: Record<string, unknown>;
  created_at: string;
  schema_version: string;
}

export interface ArtifactSelectionInput {
  run_id: RunId;
  task_id: TaskId;
  driver_result: DriverRunResult;
  gate_results: GateResult[];
  evidence_pack?: EvidencePack;
}

export interface ArtifactSelectorOptions {
  mode: SelectionMode;
  councilProvider?: CouncilProvider;
}

/**
 * ArtifactSelector: Unified artifact selection for single-agent and council modes.
 *
 * - single_agent mode: directly selects the first artifact from driver result if gates allow
 * - council mode: delegates to CouncilProvider, currently also selects first artifact via MockCouncil
 *
 * Both modes return the same ArtifactSelectionResult structure.
 */
export class ArtifactSelector {
  private readonly options: ArtifactSelectorOptions;

  constructor(options: ArtifactSelectorOptions) {
    this.options = options;
  }

  async selectArtifacts(input: ArtifactSelectionInput): Promise<ArtifactSelectionResult> {
    if (this.options.mode === 'single_agent') {
      return this.selectSingleAgent(input);
    } else {
      return this.selectViaCouncil(input);
    }
  }

  private async selectSingleAgent(input: ArtifactSelectionInput): Promise<ArtifactSelectionResult> {
    const firstArtifact = input.driver_result.artifacts[0];
    const allGatesAllow = input.gate_results.every((g) => g.decision === 'allow');
    const succeeded = input.driver_result.status === 'succeeded';

    const selected =
      succeeded && allGatesAllow && firstArtifact !== undefined ? [firstArtifact] : [];

    return {
      selection_id: createId('selection'),
      run_id: input.run_id,
      task_id: input.task_id,
      mode: 'single_agent',
      selected_artifacts: selected,
      reason:
        selected.length > 0
          ? 'Single agent: direct selection of driver output after gate validation'
          : 'Single agent: no artifact selected (driver failed or gates blocked)',
      metadata: {
        driver_run_result_id: input.driver_result.driver_run_result_id,
        driver_status: input.driver_result.status,
        gates_passed: allGatesAllow,
      },
      created_at: nowTimestamp(),
      schema_version: SCHEMA_VERSION,
    };
  }

  private async selectViaCouncil(input: ArtifactSelectionInput): Promise<ArtifactSelectionResult> {
    if (!this.options.councilProvider) {
      throw new Error('councilProvider is required when mode is "council"');
    }

    if (!input.evidence_pack) {
      throw new Error('evidence_pack is required when mode is "council"');
    }

    const firstArtifact = input.driver_result.artifacts[0];

    // Build proposal from driver result artifacts
    const proposal: Proposal = {
      proposal_id: createId('proposal'),
      run_id: input.run_id,
      task_id: input.task_id,
      artifact_refs: input.driver_result.artifacts.map((a) => a.artifact_id),
      summary: 'Driver output artifacts for council review',
      created_at: nowTimestamp(),
      schema_version: SCHEMA_VERSION,
    };

    const councilDecision = await this.options.councilProvider.runCouncilRound({
      run_id: input.run_id,
      task_id: input.task_id,
      proposals: [proposal],
      evidence_pack: input.evidence_pack,
    });

    // Convert council verdict to selection
    const selected =
      councilDecision.verdict === 'accept' && firstArtifact !== undefined ? [firstArtifact] : [];

    return {
      selection_id: createId('selection'),
      run_id: input.run_id,
      task_id: input.task_id,
      mode: 'council',
      selected_artifacts: selected,
      reason: councilDecision.reason,
      metadata: {
        council_decision_id: councilDecision.decision_id,
        proposal_id: proposal.proposal_id,
        verdict: councilDecision.verdict,
        selected_proposal_id: councilDecision.selected_proposal_id,
      },
      created_at: nowTimestamp(),
      schema_version: SCHEMA_VERSION,
    };
  }
}

/**
 * Factory function to create an ArtifactSelector with sensible defaults.
 *
 * @param mode - 'single_agent' (default) or 'council'
 * @param councilProvider - optional, defaults to MockCouncil for council mode
 */
export function createArtifactSelector(
  mode: SelectionMode = 'single_agent',
  councilProvider?: CouncilProvider,
): ArtifactSelector {
  const options: ArtifactSelectorOptions = { mode };
  if (mode === 'council') {
    options.councilProvider = councilProvider ?? new MockCouncil();
  }
  return new ArtifactSelector(options);
}
