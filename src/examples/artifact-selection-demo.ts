/**
 * Example demonstrating artifact-finalizer and worktree-materializer modules.
 *
 * This shows how to use:
 * 1. ArtifactSelector in single_agent and council modes
 * 2. WorktreeMaterializer to write artifacts to worktree
 *
 * Demo artifacts are written to .newide/demo-worktrees/ (gitignored)
 *
 * Run with:
 *   pnpm tsx src/examples/artifact-selection-demo.ts
 */

import { SCHEMA_VERSION, createId, nowTimestamp } from '../core';
import { createArtifactSelector } from '../coordinator/artifact-finalizer';
import { createWorktreeMaterializer } from '../coordinator/worktree-materializer';
import { MockCouncil } from '../council';
import type { DriverRunResult } from '../driver';
import type { GateResult } from '../gate';
import type { EvidencePack } from '../council';

// Mock driver result with a patch artifact
const mockDriverResult: DriverRunResult = {
  driver_run_result_id: createId('driver_result'),
  session_id: 'demo-session',
  status: 'succeeded',
  artifacts: [
    {
      artifact_id: createId('artifact'),
      type: 'patch',
      uri: 'artifact://patch/demo',
      producer_id: 'mock-driver',
      task_id: 'demo-task',
      metadata: { content: 'demo patch content', lines_added: 10, lines_removed: 2 },
      created_at: nowTimestamp(),
      schema_version: SCHEMA_VERSION,
    },
  ],
  transcript_ref: {
    artifact_id: createId('artifact'),
    type: 'transcript',
    uri: 'artifact://transcript/demo',
    producer_id: 'mock-driver',
    created_at: nowTimestamp(),
    schema_version: SCHEMA_VERSION,
  },
  tool_events: [],
  diagnostics: {
    driver_id: 'mock-driver',
    duration_ms: 150,
    notes: ['demo run'],
  },
  created_at: nowTimestamp(),
  schema_version: SCHEMA_VERSION,
};

// Mock gate result
const mockGateResult: GateResult = {
  gate_result_id: createId('gate_result'),
  gate_point: 'task.completed',
  gate_id: 'demo-gate',
  request_id: createId('gate_request'),
  subject_id: 'demo-task',
  decision: 'allow',
  reason: 'Demo gate passed',
  target_state: 'reviewing',
  required_actions: [],
  created_at: nowTimestamp(),
  schema_version: SCHEMA_VERSION,
};

// Mock evidence pack
const mockEvidencePack: EvidencePack = {
  evidence_pack_id: createId('evidence_pack'),
  task_id: 'demo-task-2',
  context_pack_ref: 'demo-context',
  artifact_refs: ['artifact-1'],
  gate_result_refs: ['gate-result-1'],
  summary: 'Demo evidence pack for council artifact selection',
  created_at: nowTimestamp(),
  schema_version: SCHEMA_VERSION,
};

async function demo() {
  console.log('🎯 Artifact Selection & Materialization Demo\n');

  // Demo 1: Single Agent Selection
  console.log('📌 Demo 1: Single Agent Selection');
  const singleAgentSelector = createArtifactSelector('single_agent');
  const singleAgentResult = await singleAgentSelector.selectArtifacts({
    run_id: 'demo-run-1',
    task_id: 'demo-task-1',
    driver_result: mockDriverResult,
    gate_results: [mockGateResult],
  });

  console.log(`  Mode: ${singleAgentResult.mode}`);
  console.log(`  Selected artifacts: ${singleAgentResult.selected_artifacts.length}`);
  console.log(`  Reason: ${singleAgentResult.reason}`);
  console.log(`  Metadata:`, JSON.stringify(singleAgentResult.metadata, null, 2));

  // Demo 2: Council Selection
  console.log('\n📌 Demo 2: Council Selection');
  const councilSelector = createArtifactSelector('council', new MockCouncil());
  const councilResult = await councilSelector.selectArtifacts({
    run_id: 'demo-run-2',
    task_id: 'demo-task-2',
    driver_result: mockDriverResult,
    gate_results: [mockGateResult],
    evidence_pack: mockEvidencePack,
  });

  console.log(`  Mode: ${councilResult.mode}`);
  console.log(`  Selected artifacts: ${councilResult.selected_artifacts.length}`);
  console.log(`  Reason: ${councilResult.reason}`);
  console.log(`  Metadata:`, JSON.stringify(councilResult.metadata, null, 2));

  // Demo 3: Worktree Materialization
  console.log('\n📌 Demo 3: Worktree Materialization');
  // Use .newide/demo-worktrees for demo results (similar to .claude/ directory)
  const demoWorktreePath = '.newide/demo-worktrees';
  const materializer = createWorktreeMaterializer(demoWorktreePath);

  const materializationResult = await materializer.materialize({
    task_id: 'demo-task-1',
    artifacts: singleAgentResult.selected_artifacts,
  });

  console.log(`  Worktree path: ${materializationResult.worktree_path}`);
  console.log(`  Files written: ${materializationResult.files_written.length}`);
  console.log(`  Files:`, materializationResult.files_written);

  console.log('\n✅ Demo completed successfully!');
  console.log(
    `\nℹ️  Check ${materializationResult.worktree_path} to see the materialized artifacts.`,
  );
}

demo().catch((error) => {
  console.error('❌ Demo failed:', error);
  process.exit(1);
});
