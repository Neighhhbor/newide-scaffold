import {
  SCHEMA_VERSION,
  createId,
  nowTimestamp,
  type Checkpoint,
  type Message,
  type MessageId,
  type RoleProfileRef,
  type SchemaVersion,
  type TaskCreateRequest,
  type Timestamp,
} from '../core';
import { MockDriver, type DriverRunResult, type DriverRuntimeHandle } from '../driver';
import { HookEngine } from '../hook';
import { DecisionAggregator, type GateResult } from '../gate';
import { MockMemoryProvider } from '../memory';
import { RuntimeOrchestrator } from './orchestrator';
import type { TelemetrySink } from '../telemetry/telemetry-sink';
import {
  ArtifactSelector,
  type ArtifactSelectionResult,
  type SelectionMode,
} from './artifact-finalizer';
import { WorktreeMaterializer, type MaterializationResult } from './worktree-materializer';
import {
  MockCouncil,
  type CouncilDecision,
  type CouncilProvider,
  type EvidencePack,
} from '../council';
import {
  buildCouncilDecisionOutputPaths,
  writeCouncilDecisionOutput,
} from '../council/council-decision-output';
import { InMemoryMailboxStore, type MessageDelivery } from './mailbox-store';
import {
  sendDriverCompletedMessage,
  sendDriverRequestedMessage,
  sendTaskAssignedMessage,
} from './mailbox-handoff';
import { buildArtifactOutputs, type ArtifactOutput } from './artifact-output';
import {
  buildRunOutputPaths,
  buildRunResultManifest,
  writeIntegrationRunOutputs,
  type IntegrationRunResultManifest,
} from './run-result';
import { buildFrontendRunSnapshot, type FrontendRunSnapshot } from './frontend-run-snapshot';

export interface IntegrationV0TimelineItem {
  name: string;
  id: string;
}

export interface IntegrationV0Summary {
  run_id: string;
  task_id: string;
  mode: SelectionMode;
  status: 'completed' | 'failed';
  worktree_path: string;
  artifacts_materialized: number;
  files_written: string[];
  artifact_outputs: ArtifactOutput[];
  driver_diagnostics: {
    driver_id: string;
    duration_ms: number;
  };
  checkpoint_id: string;
  checkpoint_path: string;
  mailbox_message_refs: MessageId[];
  mailbox_thread_id: string;
  council_decision_path?: string;
  council_decision_id?: string;
  council_decision_mode?: CouncilDecision['decision_mode'];
  council_verdict?: CouncilDecision['verdict'];
  council_selected_artifact_refs?: string[];
  council_can_create_merge_authorization?: boolean;
  created_at: Timestamp;
  schema_version: SchemaVersion;
}

export interface IntegrationV0Options {
  driver?: DriverRuntimeHandle;
  driverPrompt?: string;
  enableCouncil?: boolean;
  councilProvider?: CouncilProvider;
  worktreePath?: string;
  telemetry?: TelemetrySink;
}

export interface IntegrationV0Result {
  run_id: string;
  task_id: string;
  timeline: IntegrationV0TimelineItem[];
  driver_result: DriverRunResult;
  selection_result: ArtifactSelectionResult;
  materialization_result: MaterializationResult;
  mailbox_thread: Message[];
  mailbox_deliveries: MessageDelivery[];
  summary: IntegrationV0Summary;
  frontend_snapshot: FrontendRunSnapshot;
  result_manifest: IntegrationRunResultManifest;
}

/**
 * Integration v0 Flow: End-to-end integration from task creation to worktree materialization.
 *
 * This is a v0 runner that connects A-B-C-D modules:
 * - A: Driver (MockDriver or ExternalDriverRuntime)
 * - B: Memory (MockMemoryProvider)
 * - C: Coordinator (RuntimeOrchestrator, ArtifactSelector, InMemoryMailboxStore)
 * - D: Gate (HookEngine)
 *
 * Key features:
 * - Real mailbox send/ack mechanism (task.assigned, driver.requested, driver.completed)
 * - Persistent output to .newide/runs/<run_id>/ (result.json, summary.json, timeline.json)
 * - Support single_agent (default) and council modes
 * - Support MockDriver (default) and external driver injection
 */
export async function runIntegrationV0Flow(
  options?: IntegrationV0Options,
): Promise<IntegrationV0Result> {
  const orchestrator = new RuntimeOrchestrator(
    options?.telemetry ? { telemetry: options.telemetry } : undefined,
  );
  const mailbox = new InMemoryMailboxStore();
  const timeline: IntegrationV0TimelineItem[] = [];
  const mailboxMessageRefs: MessageId[] = [];

  // 1. Create task
  const taskRequest: TaskCreateRequest = {
    spec: options?.driverPrompt || 'Run the integration v0 flow',
    role_id: 'role_ts_engineer',
    risk_level: 'low',
    affected_paths: ['src/**'],
    completion_criteria: ['integration v0 flow completes successfully'],
  };
  const task = orchestrator.createTask(taskRequest);
  timeline.push({ name: 'TaskCreated', id: task.task_id });

  // 2. Create run
  const run = orchestrator.createRun(task.task_id);
  const threadId = run.run_id; // Use run_id as thread_id for v0
  timeline.push({ name: 'RunCreated', id: run.run_id });
  orchestrator.updateRunStatus(run.run_id, 'running');
  orchestrator.updateTaskStatus(task.task_id, 'running');

  // 3. Select driver (injected or default MockDriver)
  const driver = options?.driver ?? new MockDriver();

  // 4. Mailbox: send task.assigned
  const taskAssignedResult = sendTaskAssignedMessage({
    mailbox,
    thread_id: threadId,
    task_id: task.task_id,
    driver_id: driver.driver_id,
    driver_session_id: driver.session_id,
  });
  mailboxMessageRefs.push(taskAssignedResult.message.message_id);

  // Record mailbox message sent event
  const taskAssignedEvent = orchestrator.appendEvent({
    event_type: 'mailbox.message_sent',
    subject_id: taskAssignedResult.message.message_id,
    run_id: run.run_id,
    task_id: task.task_id,
    payload: {
      message_type: 'task.assigned',
      from_agent_id: 'coordinator',
      to_agent_id: driver.driver_id,
    },
  });
  timeline.push({ name: 'MailboxMessageSent (task.assigned)', id: taskAssignedEvent.event_id });

  // 5. Build context pack (B: Memory)
  const roleProfileRef: RoleProfileRef = {
    role_id: 'role_ts_engineer',
    persona_ref: 'persona://role_ts_engineer/current',
    skill_refs: ['skill://typescript-integration'],
    capability_tags: ['typescript', 'integration', 'v0'],
    memory_policy: {
      allow_in_driver_context: true,
      allow_in_council_proposer: true,
      allow_in_council_judge: true,
      max_memory_items: 5,
    },
    schema_version: SCHEMA_VERSION,
  };

  const memory = new MockMemoryProvider();
  const contextPack = await memory.buildContextPack({
    task_id: task.task_id,
    role_profile_ref: roleProfileRef,
    memory_refs: [
      {
        memory_id: 'memory_integration_v0',
        kind: 'experience',
        uri: 'memory://integration/v0',
        summary: 'Integration v0 flow connects A-B-C-D modules.',
        schema_version: SCHEMA_VERSION,
      },
    ],
    artifact_refs: [],
  });
  const contextEvent = orchestrator.appendEvent({
    event_type: 'memory.context_pack_built',
    subject_id: contextPack.context_pack_id,
    run_id: run.run_id,
    task_id: task.task_id,
    payload: {
      role_id: contextPack.role_profile_ref.role_id,
      memory_refs: contextPack.memory_refs.map((memoryRef) => memoryRef.memory_id),
    },
  });
  timeline.push({ name: 'ContextPackBuilt', id: contextEvent.event_id });

  // 6. Start driver session
  const sessionEvent = orchestrator.appendEvent({
    event_type: 'driver.session_started',
    subject_id: driver.session_id,
    run_id: run.run_id,
    task_id: task.task_id,
    payload: {
      driver_id: driver.driver_id,
      capabilities: driver.capabilities,
    },
  });
  timeline.push({ name: 'DriverSessionStarted', id: sessionEvent.event_id });

  // 7. Mailbox: send driver.requested
  const driverRequestedResult = sendDriverRequestedMessage({
    mailbox,
    thread_id: threadId,
    task_id: task.task_id,
    run_id: run.run_id,
    driver_id: driver.driver_id,
    prompt: options?.driverPrompt || taskRequest.spec,
  });
  mailboxMessageRefs.push(driverRequestedResult.message.message_id);

  // Record mailbox message sent event
  const driverRequestedEvent = orchestrator.appendEvent({
    event_type: 'mailbox.message_sent',
    subject_id: driverRequestedResult.message.message_id,
    run_id: run.run_id,
    task_id: task.task_id,
    payload: {
      message_type: 'driver.requested',
      from_agent_id: 'coordinator',
      to_agent_id: driver.driver_id,
      requires_ack: true,
    },
  });
  timeline.push({
    name: 'MailboxMessageSent (driver.requested)',
    id: driverRequestedEvent.event_id,
  });

  const driverRequestedAckEvent = orchestrator.appendEvent({
    event_type: 'mailbox.message_acked',
    subject_id: driverRequestedResult.acked_delivery.delivery_id,
    run_id: run.run_id,
    task_id: task.task_id,
    payload: {
      message_id: driverRequestedResult.message.message_id,
      message_type: 'driver.requested',
      acked_by: driver.driver_id,
    },
  });
  timeline.push({
    name: 'MailboxMessageAcked (driver.requested)',
    id: driverRequestedAckEvent.event_id,
  });

  // 8. Call driver (A: Driver)
  const driverResult = await driver.sendPrompt({
    task_id: task.task_id,
    run_id: run.run_id,
    prompt: options?.driverPrompt || taskRequest.spec,
    context_pack_ref: {
      context_pack_id: contextPack.context_pack_id,
      task_id: contextPack.task_id,
      uri: `artifact://context/${task.task_id}/${contextPack.context_pack_id}`,
      schema_version: SCHEMA_VERSION,
    },
    created_at: nowTimestamp(),
    schema_version: SCHEMA_VERSION,
  });

  // 9. Mailbox: send driver.completed
  const driverCompletedResult = sendDriverCompletedMessage({
    mailbox,
    thread_id: threadId,
    task_id: task.task_id,
    run_id: run.run_id,
    driver_id: driver.driver_id,
    driver_result: driverResult,
  });
  mailboxMessageRefs.push(driverCompletedResult.message.message_id);

  // Record mailbox message sent event
  const driverCompletedEvent = orchestrator.appendEvent({
    event_type: 'mailbox.message_sent',
    subject_id: driverCompletedResult.message.message_id,
    run_id: run.run_id,
    task_id: task.task_id,
    payload: {
      message_type: 'driver.completed',
      from_agent_id: driver.driver_id,
      to_agent_id: 'coordinator',
      status: driverResult.status,
    },
  });
  timeline.push({
    name: 'MailboxMessageSent (driver.completed)',
    id: driverCompletedEvent.event_id,
  });

  const driverResultEvent = orchestrator.appendEvent({
    event_type: 'driver.run_result',
    subject_id: driverResult.driver_run_result_id,
    run_id: run.run_id,
    task_id: task.task_id,
    payload: {
      status: driverResult.status,
      artifact_refs: driverResult.artifacts.map((artifact) => artifact.artifact_id),
      transcript_ref: driverResult.transcript_ref.artifact_id,
    },
  });
  timeline.push({ name: 'DriverRunResult', id: driverResultEvent.event_id });

  // 10. Register artifacts
  for (const artifact of driverResult.artifacts) {
    orchestrator.registerArtifact(artifact);
  }
  orchestrator.registerArtifact(driverResult.transcript_ref);
  if (driverResult.artifacts.length > 0) {
    timeline.push({ name: 'ArtifactRegistered', id: driverResult.artifacts[0]!.artifact_id });
  }

  // 11. Run gates (D: Gate)
  orchestrator.updateTaskStatus(task.task_id, 'reviewing');
  const taskCompletedEvent = orchestrator.appendEvent({
    event_type: 'task.completed',
    subject_id: task.task_id,
    run_id: run.run_id,
    task_id: task.task_id,
    payload: {
      summary: 'Driver completed the task.',
      artifact_refs: driverResult.artifacts.map((a) => a.artifact_id),
    },
  });
  timeline.push({ name: 'TaskCompleted', id: taskCompletedEvent.event_id });

  const hookEngine = new HookEngine({
    config: {
      version: 'hook-0.1',
      settings: {
        fail_fast: false,
        default_timeout: 30,
        parallel: false,
        output_format: 'json',
        emergency_env_var: 'AGENT_EMERGENCY_SKIP',
      },
      gates: {
        'allow-gate': {
          type: 'command',
          run: 'node -e "process.exit(0)"',
          retry_threshold: 1,
        },
      },
      hooks: {
        'task.completed': [{ gate: 'allow-gate', priority: 100, timeout: 30 }],
      },
    },
    aggregator: new DecisionAggregator(),
  });

  const hookResult = await hookEngine.handleEvent({
    ...taskCompletedEvent,
    event_type: 'task.completed',
  });

  const hookEvent = orchestrator.appendEvent({
    event_type: 'hook.matched',
    subject_id: taskCompletedEvent.event_id,
    run_id: run.run_id,
    task_id: task.task_id,
    payload: {
      hook_point: hookResult.hook_point,
      matched: hookResult.matched,
    },
  });
  timeline.push({ name: 'HookMatched', id: hookEvent.event_id });

  const gateResults: GateResult[] = hookResult.gate_results;
  if (gateResults.length > 0) {
    const firstGateResult = gateResults[0]!;
    const gateResultEvent = orchestrator.appendEvent({
      event_type: 'gate.result',
      subject_id: firstGateResult.gate_result_id,
      run_id: run.run_id,
      task_id: task.task_id,
      payload: {
        decision: firstGateResult.decision,
        reason: firstGateResult.reason,
      },
    });
    timeline.push({ name: 'GateResult', id: gateResultEvent.event_id });
  }

  // 12. Artifact selection (C: Coordinator)
  const evidencePack: EvidencePack = {
    evidence_pack_id: createId('evidence_pack'),
    task_id: task.task_id,
    context_pack_ref: contextPack.context_pack_id,
    artifact_refs: driverResult.artifacts.map((a) => a.artifact_id),
    gate_result_refs: gateResults.map((g) => g.gate_result_id),
    summary: 'Driver artifacts and gate results for v0 artifact selection.',
    created_at: nowTimestamp(),
    schema_version: SCHEMA_VERSION,
  };

  const selectorOptions: {
    mode: SelectionMode;
    councilProvider?: CouncilProvider;
  } = {
    mode: options?.enableCouncil ? 'council' : 'single_agent',
  };
  if (options?.enableCouncil) {
    selectorOptions.councilProvider = options.councilProvider ?? new MockCouncil();
  }
  const selector = new ArtifactSelector(selectorOptions);

  const selectionResult = await selector.selectArtifacts({
    run_id: run.run_id,
    task_id: task.task_id,
    driver_result: driverResult,
    gate_results: gateResults,
    evidence_pack: evidencePack,
  });

  if (selectionResult.council_decision) {
    const councilDecision = selectionResult.council_decision;
    const councilEvent = orchestrator.appendEvent({
      event_type: 'council.decision',
      subject_id: councilDecision.decision_id,
      run_id: run.run_id,
      task_id: task.task_id,
      payload: {
        decision_mode: councilDecision.decision_mode,
        selected_proposal_id: councilDecision.selected_proposal_id,
        verdict: councilDecision.verdict,
        comparison_ref: councilDecision.comparison_ref,
        can_create_merge_authorization: councilDecision.can_create_merge_authorization,
      },
    });
    timeline.push({ name: 'CouncilDecision', id: councilEvent.event_id });
  }

  const selectionEvent = orchestrator.appendEvent({
    event_type: 'artifact.selected',
    subject_id: selectionResult.selection_id,
    run_id: run.run_id,
    task_id: task.task_id,
    payload: {
      mode: selectionResult.mode,
      selected_count: selectionResult.selected_artifacts.length,
    },
  });
  timeline.push({ name: 'ArtifactSelected', id: selectionEvent.event_id });

  // 13. Worktree materialization (C: Coordinator)
  const materializer = new WorktreeMaterializer({
    baseWorktreePath: options?.worktreePath || '.newide/worktrees',
  });

  const materializationResult = await materializer.materialize({
    task_id: task.task_id,
    artifacts: selectionResult.selected_artifacts,
  });

  const materializationEvent = orchestrator.appendEvent({
    event_type: 'worktree.materialized',
    subject_id: materializationResult.materialization_id,
    run_id: run.run_id,
    task_id: task.task_id,
    payload: {
      worktree_path: materializationResult.worktree_path,
      files_written: materializationResult.files_written.length,
    },
  });
  timeline.push({ name: 'WorktreeMaterialized', id: materializationEvent.event_id });

  // 14. Calculate flow completion status
  const driverSucceeded = driverResult.status === 'succeeded';
  const gatesPassed = gateResults.length > 0 && gateResults.every((g) => g.decision === 'allow');
  const hasSelectedArtifact = selectionResult.selected_artifacts.length > 0;
  const materialized = materializationResult.files_written.length > 0;
  const flowCompleted = driverSucceeded && gatesPassed && hasSelectedArtifact && materialized;

  // 15. Save checkpoint (C: Coordinator long-running state)
  const diffArtifactId =
    selectionResult.selected_artifacts.length > 0
      ? selectionResult.selected_artifacts[0]!.artifact_id
      : undefined;

  const mechanicalSnapshot: Checkpoint['mechanical_snapshot'] = {
    base_commit: 'demo-head',
    snapshot_commit: 'demo-head',
    worktree_path: materializationResult.worktree_path,
    branch: 'integration-v0-demo',
    modified_files: materializationResult.files_written,
  };
  if (diffArtifactId) {
    mechanicalSnapshot.diff_artifact_id = diffArtifactId;
  }

  const doneSteps: string[] = ['task created'];
  if (driverSucceeded) doneSteps.push('driver completed');
  if (gatesPassed) doneSteps.push('gates passed');
  if (hasSelectedArtifact) doneSteps.push('artifacts selected');
  if (materialized) doneSteps.push('worktree materialized');

  const blockedOn: string[] = [];
  if (!driverSucceeded) blockedOn.push('driver execution failed');
  if (!gatesPassed) blockedOn.push('gates blocked or not evaluated');
  if (!hasSelectedArtifact) blockedOn.push('no artifacts selected');
  if (!materialized) blockedOn.push('worktree materialization failed');

  const checkpoint: Checkpoint = {
    checkpoint_id: createId('checkpoint'),
    checkpoint_type: 'full',
    task_id: task.task_id,
    agent_id: driverResult.diagnostics.driver_id,
    trigger: 'manual',
    mechanical_snapshot: mechanicalSnapshot,
    semantic_handoff: {
      done: doneSteps,
      in_progress: [],
      blocked_on: blockedOn,
      assumptions: flowCompleted
        ? ['Integration v0 flow completed successfully', 'Artifacts materialized to worktree']
        : [
            'Integration v0 flow partially completed',
            `Driver: ${driverResult.status}`,
            `Gates: ${gatesPassed ? 'passed' : 'blocked or not evaluated'}`,
            `Artifacts: ${hasSelectedArtifact ? 'selected' : 'none'}`,
          ],
      next_steps: flowCompleted
        ? ['Ready for user review', 'Can be resumed if needed']
        : ['Review failure points', 'May need retry or manual intervention'],
      known_risks: ['Checkpoint is in-memory only', 'Resume not yet implemented'],
    },
    runtime_state: {
      scheduler_policy: selectionResult.mode === 'council' ? 'council' : 'single_agent',
      current_turn: 1,
      next_agent_ref: 'user_review',
      resume_cursor: 'worktree.materialized',
    },
    artifact_refs: [
      ...selectionResult.selected_artifacts.map((a) => a.artifact_id),
      driverResult.transcript_ref.artifact_id,
    ],
    validity_status: 'valid',
    created_at: nowTimestamp(),
    schema_version: SCHEMA_VERSION,
  };

  const savedCheckpoint = orchestrator.saveCheckpoint(checkpoint);
  timeline.push({ name: 'CheckpointSaved', id: savedCheckpoint.checkpoint_id });

  // 16. Mark run as completed or failed
  const finalTaskStatus = flowCompleted ? 'completed' : 'failed';
  const finalRunStatus = flowCompleted ? 'completed' : 'failed';
  orchestrator.updateTaskStatus(task.task_id, finalTaskStatus);
  orchestrator.updateRunStatus(run.run_id, finalRunStatus);
  const runCompletedEvent = orchestrator.appendEvent({
    event_type: flowCompleted ? 'run.completed' : 'run.failed',
    subject_id: run.run_id,
    run_id: run.run_id,
    task_id: task.task_id,
    payload: {
      status: finalRunStatus,
    },
  });
  timeline.push({
    name: flowCompleted ? 'RunCompleted' : 'RunFailed',
    id: runCompletedEvent.event_id,
  });

  // 17. Build summary
  const outputPaths = buildRunOutputPaths(run.run_id);
  const councilDecisionOutputPaths = selectionResult.council_decision
    ? buildCouncilDecisionOutputPaths(run.run_id)
    : undefined;
  if (selectionResult.council_decision && councilDecisionOutputPaths) {
    await writeCouncilDecisionOutput({
      paths: councilDecisionOutputPaths,
      decision: selectionResult.council_decision,
    });
  }

  const artifactOutputs = buildArtifactOutputs({
    artifacts: selectionResult.selected_artifacts,
    materialized_record_paths: materializationResult.files_written,
  });
  const summary: IntegrationV0Summary = {
    run_id: run.run_id,
    task_id: task.task_id,
    mode: selectionResult.mode,
    status: finalRunStatus,
    worktree_path: materializationResult.worktree_path,
    artifacts_materialized: materializationResult.materialized_artifacts.length,
    files_written: materializationResult.files_written,
    artifact_outputs: artifactOutputs,
    driver_diagnostics: {
      driver_id: driverResult.diagnostics.driver_id,
      duration_ms: driverResult.diagnostics.duration_ms,
    },
    checkpoint_id: savedCheckpoint.checkpoint_id,
    checkpoint_path: outputPaths.checkpoint_path,
    mailbox_message_refs: mailboxMessageRefs,
    mailbox_thread_id: threadId,
    ...(selectionResult.council_decision && councilDecisionOutputPaths
      ? {
          council_decision_path: councilDecisionOutputPaths.decision_path,
          council_decision_id: selectionResult.council_decision.decision_id,
          council_decision_mode: selectionResult.council_decision.decision_mode,
          council_verdict: selectionResult.council_decision.verdict,
          council_selected_artifact_refs: selectionResult.council_decision.selected_artifact_refs,
          council_can_create_merge_authorization:
            selectionResult.council_decision.can_create_merge_authorization,
        }
      : {}),
    created_at: nowTimestamp(),
    schema_version: SCHEMA_VERSION,
  };
  const mailboxThread = mailbox.listThread(threadId);
  const mailboxDeliveries = mailbox.listDeliveries();
  const frontendSnapshotLinks = {
    result_path: outputPaths.result_path,
    summary_path: outputPaths.summary_path,
    timeline_path: outputPaths.timeline_path,
    checkpoint_path: outputPaths.checkpoint_path,
    message_thread_path: outputPaths.message_thread_path,
    frontend_snapshot_path: outputPaths.frontend_snapshot_path,
  };
  const frontendSnapshot = buildFrontendRunSnapshot({
    summary,
    timeline,
    checkpoint: savedCheckpoint,
    message_thread: mailboxThread,
    links: frontendSnapshotLinks,
  });
  const resultManifest = buildRunResultManifest({
    run_id: run.run_id,
    task_id: task.task_id,
    status: finalRunStatus,
    mode: selectionResult.mode,
    driver_id: driverResult.diagnostics.driver_id,
    artifact_outputs: artifactOutputs,
    result_path: outputPaths.result_path,
    summary_path: outputPaths.summary_path,
    timeline_path: outputPaths.timeline_path,
    checkpoint_path: outputPaths.checkpoint_path,
    message_thread_path: outputPaths.message_thread_path,
    frontend_snapshot_path: outputPaths.frontend_snapshot_path,
    ...(summary.council_decision_path
      ? {
          council_decision_path: summary.council_decision_path,
          council_verdict: summary.council_verdict,
          council_decision_mode: summary.council_decision_mode,
        }
      : {}),
    created_at: summary.created_at,
    schema_version: SCHEMA_VERSION,
  });

  // 18. Persist summary, timeline, checkpoint, and result manifest.
  await writeIntegrationRunOutputs({
    paths: outputPaths,
    summary,
    timeline,
    checkpoint: savedCheckpoint,
    message_thread: mailboxThread,
    frontend_snapshot: frontendSnapshot,
    result_manifest: resultManifest,
  });

  return {
    run_id: run.run_id,
    task_id: task.task_id,
    timeline,
    driver_result: driverResult,
    selection_result: selectionResult,
    materialization_result: materializationResult,
    mailbox_thread: mailboxThread,
    mailbox_deliveries: mailboxDeliveries,
    summary,
    frontend_snapshot: frontendSnapshot,
    result_manifest: resultManifest,
  };
}
