import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import {
  runIntegrationV0Flow,
  type IntegrationV0Options,
  type IntegrationV0Result,
} from '../../src/coordinator/integration-v0-flow';
import {
  MockDriver,
  type DriverRuntimeHandle,
  type DriverPrompt,
  type DriverRunResult,
} from '../../src/driver';
import { SCHEMA_VERSION, createId, type ArtifactRef } from '../../src/core';
import type { CouncilProvider, CouncilRoundInput } from '../../src/council';
import type { AgentExecutionFacade, AgentExecutionRequest } from '../../src/memory';

describe('runIntegrationV0Flow', () => {
  const createdRunDirs = new Set<string>();
  const createdWorktreeDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...createdRunDirs, ...createdWorktreeDirs].map((dir) =>
        fs.rm(dir, { recursive: true, force: true }),
      ),
    );
    createdRunDirs.clear();
    createdWorktreeDirs.clear();
  });

  it('should run complete flow with MockDriver and single_agent mode', async () => {
    const result = await runFlow();

    expect(result.run_id).toBeDefined();
    expect(result.task_id).toBeDefined();
    expect(result.summary.mode).toBe('single_agent');
    expect(result.summary.status).toBe('completed');

    // Verify mailbox events in timeline
    const timelineNames = result.timeline.map((t) => t.name);
    expect(timelineNames).toContain('MailboxMessageSent (task.assigned)');
    expect(timelineNames).toContain('MailboxMessageSent (driver.requested)');
    expect(timelineNames).toContain('MailboxMessageSent (driver.completed)');
    expect(timelineNames).toContain('MailboxMessageAcked (driver.requested)');
    expect(timelineNames.indexOf('MailboxMessageAcked (driver.requested)')).toBeLessThan(
      timelineNames.indexOf('DriverRunResult'),
    );

    expect(result.mailbox_thread.map((message) => message.type)).toEqual([
      'task.assigned',
      'driver.requested',
      'driver.completed',
    ]);

    const driverRequested = result.mailbox_thread.find(
      (message) => message.type === 'driver.requested',
    );
    expect(driverRequested).toBeDefined();
    if (!driverRequested) {
      throw new Error('driver.requested mailbox message was not found');
    }
    expect(driverRequested.requires_ack).toBe(true);
    expect(driverRequested.deadline_seconds).toBe(300);

    const driverRequestedDelivery = result.mailbox_deliveries.find(
      (delivery) => delivery.message_id === driverRequested.message_id,
    );
    expect(driverRequestedDelivery).toBeDefined();
    if (!driverRequestedDelivery) {
      throw new Error('driver.requested mailbox delivery was not found');
    }
    expect(driverRequestedDelivery.status).toBe('acked');
    expect(driverRequestedDelivery.ack_at).toBeDefined();
  });

  it('should run with council mode when enabled', async () => {
    const result = await runFlow({ enableCouncil: true });
    const councilDecisionPath = `.newide/runs/${result.run_id}/council/decision.json`;
    const councilProposalsPath = `.newide/runs/${result.run_id}/council/proposals.json`;
    const councilReviewsPath = `.newide/runs/${result.run_id}/council/reviews.json`;
    const councilOutputPath = `.newide/runs/${result.run_id}/council/output.json`;

    expect(result.summary.mode).toBe('council');
    expect(result.summary.status).toBe('completed');
    expect(result.selection_result.council_decision).toMatchObject({
      run_id: result.run_id,
      task_id: result.task_id,
      decision_mode: 'advisory',
      verdict: 'select',
      selected_artifact_refs: result.selection_result.selected_artifacts.map(
        (artifact) => artifact.artifact_id,
      ),
      can_create_merge_authorization: false,
    });
    expect(result.selection_result.metadata).toMatchObject({
      decision_mode: 'advisory',
      verdict: 'select',
      can_create_merge_authorization: false,
    });

    const timelineNames = result.timeline.map((t) => t.name);
    expect(timelineNames).toContain('CouncilDecision');
    expect(timelineNames.indexOf('CouncilDecision')).toBeLessThan(
      timelineNames.indexOf('ArtifactSelected'),
    );

    await expect(readJson(councilDecisionPath)).resolves.toMatchObject({
      decision_id: result.selection_result.council_decision?.decision_id,
      decision_mode: 'advisory',
      verdict: 'select',
      selected_artifact_refs: result.selection_result.selected_artifacts.map(
        (artifact) => artifact.artifact_id,
      ),
      can_create_merge_authorization: false,
    });

    await expect(readJson(`.newide/runs/${result.run_id}/result.json`)).resolves.toMatchObject({
      council_decision_path: councilDecisionPath,
      council_proposals_path: councilProposalsPath,
      council_reviews_path: councilReviewsPath,
      council_output_path: councilOutputPath,
      council_verdict: 'select',
      council_decision_mode: 'advisory',
    });
    await expect(readJson(councilProposalsPath)).resolves.toEqual(
      result.selection_result.council_run_result?.proposals,
    );
    await expect(readJson(councilReviewsPath)).resolves.toEqual(
      result.selection_result.council_run_result?.reviews,
    );
    await expect(readJson(councilOutputPath)).resolves.toEqual(
      result.selection_result.council_run_result?.output,
    );

    await expect(
      readJson(`.newide/runs/${result.run_id}/frontend-snapshot.json`),
    ).resolves.toMatchObject({
      council: {
        decision_path: councilDecisionPath,
        proposals_path: councilProposalsPath,
        reviews_path: councilReviewsPath,
        output_path: councilOutputPath,
        decision_id: result.selection_result.council_decision?.decision_id,
        decision_mode: 'advisory',
        verdict: 'select',
        selected_artifact_refs: result.selection_result.selected_artifacts.map(
          (artifact) => artifact.artifact_id,
        ),
        can_create_merge_authorization: false,
      },
    });

    const eventLog = await readJson(`.newide/runs/${result.run_id}/event-log.json`);
    const eventTypes = eventLog.map((event: { event_type?: string }) => event.event_type);
    expect(eventTypes.indexOf('council.started')).toBeLessThan(
      eventTypes.indexOf('council.decision'),
    );
    expect(eventTypes.indexOf('council.decision')).toBeLessThan(
      eventTypes.indexOf('council.completed'),
    );
    expect(eventLog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_type: 'council.started',
          subject_id: result.run_id,
          run_id: result.run_id,
          task_id: result.task_id,
          payload: expect.objectContaining({
            trigger: 'user_choice',
            decision_mode: 'advisory',
            candidate_artifact_refs: result.driver_result.artifacts.map(
              (artifact) => artifact.artifact_id,
            ),
          }),
        }),
        expect.objectContaining({
          event_type: 'council.decision',
          subject_id: result.selection_result.council_decision?.decision_id,
          run_id: result.run_id,
          task_id: result.task_id,
          payload: expect.objectContaining({
            verdict: 'select',
            can_create_merge_authorization: false,
            termination_reason: 'select',
            current_round_count: 1,
            decision_packet_ref: result.selection_result.council_decision?.decision_id,
          }),
        }),
        expect.objectContaining({
          event_type: 'council.completed',
          subject_id: result.selection_result.council_run_result?.council_run_id,
          run_id: result.run_id,
          task_id: result.task_id,
          payload: expect.objectContaining({
            decision_id: result.selection_result.council_decision?.decision_id,
            verdict: 'select',
            selected_artifact_refs: result.selection_result.selected_artifacts.map(
              (artifact) => artifact.artifact_id,
            ),
            total_rounds: 1,
          }),
        }),
      ]),
    );
  });

  it('should use an injected council provider in council mode', async () => {
    const seenInputs: CouncilRoundInput[] = [];
    const injectedCouncilProvider: CouncilProvider = {
      async runCouncilRound(input) {
        seenInputs.push(input);
        const selectedProposal = input.proposals[0];
        const selectedArtifactRefs = selectedProposal?.artifact_refs.slice(0, 1) ?? [];

        return {
          council_run_id: 'council_run_injected',
          ...(input.run_id ? { run_id: input.run_id } : {}),
          task_id: input.task_id,
          proposals: input.proposals,
          reviews: [],
          decision: {
            decision_id: 'council_decision_injected',
            ...(input.run_id ? { run_id: input.run_id } : {}),
            task_id: input.task_id,
            ...(selectedProposal ? { selected_proposal_id: selectedProposal.proposal_id } : {}),
            decision_mode: input.decision_mode,
            selected_artifact_refs: selectedArtifactRefs,
            verdict: selectedArtifactRefs.length > 0 ? 'select' : 'needs_human',
            reason: 'Injected council provider selected the first artifact.',
            evidence_refs: input.evidence_pack ? [input.evidence_pack.evidence_pack_id] : [],
            can_create_merge_authorization: false,
            created_at: new Date().toISOString(),
            schema_version: SCHEMA_VERSION,
          },
          generated_artifact_refs: [],
          selected_artifact_refs: selectedArtifactRefs,
          created_at: new Date().toISOString(),
          schema_version: SCHEMA_VERSION,
        };
      },
    };

    const result = await runFlow({
      enableCouncil: true,
      councilProvider: injectedCouncilProvider,
    });

    expect(seenInputs).toHaveLength(1);
    expect(seenInputs[0]).toMatchObject({
      run_id: result.run_id,
      task_id: result.task_id,
      decision_mode: 'advisory',
    });
    expect(seenInputs[0]?.proposals[0]?.artifact_refs).toEqual(
      result.driver_result.artifacts.map((artifact) => artifact.artifact_id),
    );
    expect(seenInputs[0]?.evidence_pack).toMatchObject({
      task_id: result.task_id,
      artifact_refs: result.driver_result.artifacts.map((artifact) => artifact.artifact_id),
    });
    expect(result.selection_result.council_decision).toMatchObject({
      decision_id: 'council_decision_injected',
      selected_artifact_refs: [result.driver_result.artifacts[0]?.artifact_id],
      reason: 'Injected council provider selected the first artifact.',
    });
    expect(result.summary.council_decision_id).toBe('council_decision_injected');
    await expect(readJson(`.newide/runs/${result.run_id}/result.json`)).resolves.toMatchObject({
      council_decision_mode: 'advisory',
      council_verdict: 'select',
    });
  });

  it('should persist summary and timeline to .newide/runs/', async () => {
    const result = await runFlow();

    const summaryPath = `.newide/runs/${result.run_id}/summary.json`;
    const timelinePath = `.newide/runs/${result.run_id}/timeline.json`;

    // Verify files exist
    const summaryExists = await fs
      .access(summaryPath)
      .then(() => true)
      .catch(() => false);
    const timelineExists = await fs
      .access(timelinePath)
      .then(() => true)
      .catch(() => false);

    expect(summaryExists).toBe(true);
    expect(timelineExists).toBe(true);

    // Verify summary content
    const summaryContent = await fs.readFile(summaryPath, 'utf-8');
    const summary = JSON.parse(summaryContent);
    expect(summary.run_id).toBe(result.run_id);
    expect(summary.task_id).toBe(result.task_id);
    expect(summary.mode).toBe('single_agent');
    expect(summary.status).toBe('completed');

    // Verify timeline content
    const timelineContent = await fs.readFile(timelinePath, 'utf-8');
    const timeline = JSON.parse(timelineContent);
    expect(Array.isArray(timeline)).toBe(true);
    expect(timeline.length).toBeGreaterThan(0);
  });

  it('should persist a stable run result manifest', async () => {
    const result = await runFlow();

    const resultPath = `.newide/runs/${result.run_id}/result.json`;
    const resultContent = await fs.readFile(resultPath, 'utf-8');
    const manifest = JSON.parse(resultContent);

    expect(manifest).toMatchObject({
      run_id: result.run_id,
      task_id: result.task_id,
      status: result.summary.status,
      mode: result.summary.mode,
      driver_id: result.summary.driver_diagnostics.driver_id,
      artifact_outputs: result.summary.artifact_outputs,
      result_path: `.newide/runs/${result.run_id}/result.json`,
      summary_path: `.newide/runs/${result.run_id}/summary.json`,
      timeline_path: `.newide/runs/${result.run_id}/timeline.json`,
      checkpoint_path: `.newide/runs/${result.run_id}/checkpoint.json`,
      message_thread_path: `.newide/runs/${result.run_id}/message-thread.json`,
      event_log_path: `.newide/runs/${result.run_id}/event-log.json`,
      frontend_snapshot_path: `.newide/runs/${result.run_id}/frontend-snapshot.json`,
      schema_version: result.summary.schema_version,
    });
    expect(manifest.created_at).toBeDefined();
    expect(manifest).not.toHaveProperty('council_decision_path');
    expect(manifest).not.toHaveProperty('council_verdict');
    expect(manifest).not.toHaveProperty('council_decision_mode');
    await expect(readJson(manifest.summary_path)).resolves.toMatchObject({
      run_id: result.run_id,
    });
    await expect(readJson(manifest.timeline_path)).resolves.toEqual(expect.any(Array));
    await expect(readJson(manifest.checkpoint_path)).resolves.toMatchObject({
      checkpoint_id: result.summary.checkpoint_id,
    });
    await expect(readJson(manifest.message_thread_path)).resolves.toEqual(result.mailbox_thread);
    await expect(readJson(manifest.event_log_path)).resolves.toEqual(expect.any(Array));
    await expect(readJson(manifest.frontend_snapshot_path)).resolves.toMatchObject({
      snapshot_type: 'coordinator.frontend_run_snapshot.v0',
      run_id: result.run_id,
      task_id: result.task_id,
      current: {
        stage: 'delivery',
        task_status: result.summary.status,
      },
      links: {
        result_path: manifest.result_path,
        event_log_path: manifest.event_log_path,
      },
    });
  });

  it('should materialize artifacts to worktree', async () => {
    const result = await runFlow();

    expect(result.materialization_result.files_written.length).toBeGreaterThan(0);

    // Verify files exist
    for (const file of result.materialization_result.files_written) {
      const exists = await fs
        .access(file)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);
    }

    // Verify worktree path in summary matches materialization result
    expect(result.summary.worktree_path).toBe(result.materialization_result.worktree_path);
  });

  it('should include materialized artifact outputs in summary', async () => {
    const result = await runFlow();
    const artifact = result.selection_result.selected_artifacts[0]!;

    expect(result.summary.artifact_outputs).toEqual([
      expect.objectContaining({
        artifact_id: artifact.artifact_id,
        type: artifact.type,
        uri: artifact.uri,
        materialized_record_path: result.materialization_result.files_written[0],
      }),
    ]);
  });

  it('should work with injected driver', async () => {
    const fakeDriver = new MockDriver();
    const result = await runFlow({ driver: fakeDriver });

    expect(result.summary.status).toBe('completed');
    expect(result.driver_result.diagnostics.driver_id).toBe('mock-driver');
  });

  it('should optionally run single agent through AgentExecutionFacade without replacing the default path', async () => {
    const requests: AgentExecutionRequest[] = [];
    const agentExecutionFacade: AgentExecutionFacade = {
      async runAgent(input) {
        requests.push(input);
        return {
          agent_run_id: 'agent_run_001',
          role_id: input.role_id,
          context_pack_ref: 'context_pack_001',
          driver_run_result_id: 'driver_result_from_agent_001',
          artifact_refs: [createArtifact('artifact_from_agent_001')],
          transcript_ref: createArtifact('artifact_transcript_from_agent_001', 'transcript'),
          diagnostics: {
            driver_id: 'agent-driver',
            duration_ms: 42,
          },
          status: 'completed',
          created_at: new Date().toISOString(),
          schema_version: SCHEMA_VERSION,
        };
      },
    };

    const result = await runFlow({ agentExecutionFacade });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      task_id: result.task_id,
      run_id: result.run_id,
      role_id: 'role_ts_engineer',
      instruction: 'Run the integration v0 flow',
      context_policy: 'integration_v0_default',
    });
    expect(result.agent_execution_result).toMatchObject({
      agent_run_id: 'agent_run_001',
      status: 'completed',
    });
    expect(result.driver_result).toMatchObject({
      driver_run_result_id: 'driver_result_from_agent_001',
      status: 'succeeded',
      artifacts: [expect.objectContaining({ artifact_id: 'artifact_from_agent_001' })],
      transcript_ref: expect.objectContaining({
        artifact_id: 'artifact_transcript_from_agent_001',
      }),
    });
    expect(result.selection_result.selected_artifacts).toEqual([
      expect.objectContaining({ artifact_id: 'artifact_from_agent_001' }),
    ]);
    expect(result.timeline.map((item) => item.name)).toContain('AgentExecutionCompleted');
    expect(result.summary.status).toBe('completed');

    const eventLog = await readJson(`.newide/runs/${result.run_id}/event-log.json`);
    const eventTypes = eventLog.map((event: { event_type?: string }) => event.event_type);
    expect(eventTypes.indexOf('agent.execution_requested')).toBeLessThan(
      eventTypes.indexOf('agent.execution_completed'),
    );
    expect(eventLog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_type: 'agent.execution_requested',
          subject_id: result.run_id,
          run_id: result.run_id,
          task_id: result.task_id,
          payload: expect.objectContaining({
            role_id: 'role_ts_engineer',
            context_policy: 'integration_v0_default',
            input_artifact_refs: [],
          }),
        }),
        expect.objectContaining({
          event_type: 'agent.execution_completed',
          subject_id: 'agent_run_001',
          run_id: result.run_id,
          task_id: result.task_id,
        }),
      ]),
    );
  });

  it('should include all key timeline events', async () => {
    const result = await runFlow();

    const timelineNames = result.timeline.map((t) => t.name);

    // Core events
    expect(timelineNames).toContain('TaskCreated');
    expect(timelineNames).toContain('RunCreated');

    // Mailbox events
    expect(timelineNames).toContain('MailboxMessageSent (task.assigned)');
    expect(timelineNames).toContain('MailboxMessageSent (driver.requested)');
    expect(timelineNames).toContain('MailboxMessageSent (driver.completed)');
    expect(timelineNames).toContain('MailboxMessageAcked (driver.requested)');

    // Processing events
    expect(timelineNames).toContain('ContextPackBuilt');
    expect(timelineNames).toContain('DriverRunResult');
    expect(timelineNames).toContain('ArtifactSelected');
    expect(timelineNames).toContain('WorktreeMaterialized');
    expect(timelineNames).toContain('RunCompleted');
  });

  it('should create summary with correct structure', async () => {
    const result = await runFlow();

    expect(result.summary).toHaveProperty('run_id');
    expect(result.summary).toHaveProperty('task_id');
    expect(result.summary).toHaveProperty('mode');
    expect(result.summary).toHaveProperty('status');
    expect(result.summary).toHaveProperty('worktree_path');
    expect(result.summary).toHaveProperty('artifacts_materialized');
    expect(result.summary).toHaveProperty('files_written');
    expect(result.summary).toHaveProperty('artifact_outputs');
    expect(result.summary).toHaveProperty('driver_diagnostics');
    expect(result.summary).toHaveProperty('created_at');
    expect(result.summary).toHaveProperty('schema_version');
    expect(result.summary).toHaveProperty('mailbox_message_refs');
    expect(result.summary).toHaveProperty('mailbox_thread_id');
    expect(result.frontend_snapshot).toMatchObject({
      run_id: result.run_id,
      task_id: result.task_id,
      current: {
        stage: 'delivery',
        task_status: result.summary.status,
      },
      mailbox: {
        thread_id: result.summary.mailbox_thread_id,
      },
    });

    expect(result.summary.driver_diagnostics).toHaveProperty('driver_id');
    expect(result.summary.driver_diagnostics).toHaveProperty('duration_ms');

    // Verify mailbox fields
    expect(result.summary.mailbox_message_refs).toBeInstanceOf(Array);
    expect(result.summary.mailbox_message_refs.length).toBe(3); // task.assigned, driver.requested, driver.completed
    expect(result.summary.mailbox_thread_id).toBe(result.run_id);
  });

  it('should support custom driver prompt', async () => {
    const customPrompt = 'Custom integration test prompt';
    const result = await runFlow({ driverPrompt: customPrompt });

    expect(result.summary.status).toBe('completed');
    // Verify the prompt was used (indirectly through successful completion)
    expect(result.timeline.length).toBeGreaterThan(0);
  });

  it('should save checkpoint to .newide/runs/<run_id>/checkpoint.json', async () => {
    const result = await runFlow();

    const checkpointPath = `.newide/runs/${result.run_id}/checkpoint.json`;

    // Verify checkpoint file exists
    const checkpointExists = await fs
      .access(checkpointPath)
      .then(() => true)
      .catch(() => false);
    expect(checkpointExists).toBe(true);

    // Verify checkpoint content
    const checkpointContent = await fs.readFile(checkpointPath, 'utf-8');
    const checkpoint = JSON.parse(checkpointContent);

    expect(checkpoint.checkpoint_id).toBeDefined();
    expect(checkpoint.checkpoint_type).toBe('full');
    expect(checkpoint.task_id).toBe(result.task_id);
    expect(checkpoint.trigger).toBe('manual');
    expect(checkpoint.validity_status).toBe('valid');

    // Verify demo git snapshot fields
    expect(checkpoint.mechanical_snapshot.base_commit).toBe('demo-head');
    expect(checkpoint.mechanical_snapshot.snapshot_commit).toBe('demo-head');
    expect(checkpoint.mechanical_snapshot.branch).toBe('integration-v0-demo');

    // Verify resume_cursor is worktree.materialized
    expect(checkpoint.runtime_state.resume_cursor).toBe('worktree.materialized');
  });

  it('should include checkpoint info in summary', async () => {
    const result = await runFlow();

    expect(result.summary.checkpoint_id).toBeDefined();
    expect(result.summary.checkpoint_path).toBe(`.newide/runs/${result.run_id}/checkpoint.json`);

    // Verify checkpoint_id matches the saved checkpoint
    const checkpointPath = result.summary.checkpoint_path;
    const checkpointContent = await fs.readFile(checkpointPath, 'utf-8');
    const checkpoint = JSON.parse(checkpointContent);

    expect(checkpoint.checkpoint_id).toBe(result.summary.checkpoint_id);
  });

  it('should include CheckpointSaved in timeline', async () => {
    const result = await runFlow();

    const timelineNames = result.timeline.map((t) => t.name);
    expect(timelineNames).toContain('CheckpointSaved');

    // Verify CheckpointSaved comes after WorktreeMaterialized and before RunCompleted
    const checkpointIndex = timelineNames.indexOf('CheckpointSaved');
    const materializeIndex = timelineNames.indexOf('WorktreeMaterialized');
    const completedIndex = timelineNames.indexOf('RunCompleted');

    expect(checkpointIndex).toBeGreaterThan(materializeIndex);
    expect(checkpointIndex).toBeLessThan(completedIndex);

    // Verify CheckpointSaved event has details
    const checkpointEvent = result.timeline.find((t) => t.name === 'CheckpointSaved');
    expect(checkpointEvent).toBeDefined();
    expect(checkpointEvent!.id).toBe(result.summary.checkpoint_id);
  });

  it('should include required checkpoint fields', async () => {
    const result = await runFlow();

    const checkpointPath = `.newide/runs/${result.run_id}/checkpoint.json`;
    const checkpointContent = await fs.readFile(checkpointPath, 'utf-8');
    const checkpoint = JSON.parse(checkpointContent);

    // Verify required fields from Commit 6 spec
    expect(checkpoint.task_id).toBe(result.task_id);
    expect(checkpoint.mechanical_snapshot).toBeDefined();
    expect(checkpoint.mechanical_snapshot.worktree_path).toBe(
      result.materialization_result.worktree_path,
    );
    expect(checkpoint.mechanical_snapshot.modified_files).toEqual(
      result.materialization_result.files_written,
    );
    expect(checkpoint.artifact_refs).toContain(result.driver_result.transcript_ref.artifact_id);
    expect(checkpoint.semantic_handoff).toBeDefined();
    expect(checkpoint.semantic_handoff.done).toContain('worktree materialized');
    expect(checkpoint.runtime_state).toBeDefined();
    expect(checkpoint.runtime_state.resume_cursor).toBe('worktree.materialized');
  });

  it('should mark flow as failed when driver fails', async () => {
    // Create a mock driver that fails
    class FailingMockDriver implements DriverRuntimeHandle {
      readonly driver_id = 'mock-failing-driver';
      readonly session_id = 'failing-session';
      readonly capabilities = {
        supports_acp_extension: false,
        supports_structured_output: false,
        supports_session_load: false,
        supports_tool_events: false,
        supports_permission_events: false,
      };

      async sendPrompt(input: DriverPrompt): Promise<DriverRunResult> {
        return {
          driver_run_result_id: createId('driver_result'),
          session_id: this.session_id,
          status: 'failed',
          artifacts: [],
          transcript_ref: {
            artifact_id: createId('artifact'),
            type: 'transcript',
            uri: 'artifact://transcript/failing',
            sha256: 'mock-sha256',
            producer_id: this.driver_id,
            task_id: input.task_id,
            created_at: new Date().toISOString(),
            schema_version: SCHEMA_VERSION,
          },
          tool_events: [],
          diagnostics: {
            driver_id: this.driver_id,
            duration_ms: 100,
            notes: ['Driver failed intentionally'],
          },
          error: {
            code: 'MOCK_DRIVER_FAILED',
            message: 'Driver failed intentionally',
            retryable: false,
          },
          created_at: new Date().toISOString(),
          schema_version: SCHEMA_VERSION,
        };
      }

      async collectTranscript(taskId = 'task'): Promise<ArtifactRef> {
        return {
          artifact_id: createId('artifact'),
          type: 'transcript',
          uri: 'artifact://transcript/failing',
          sha256: 'mock-sha256',
          producer_id: this.driver_id,
          task_id: taskId,
          created_at: new Date().toISOString(),
          schema_version: SCHEMA_VERSION,
        };
      }

      async interrupt(_reason: string): Promise<void> {}

      async close(): Promise<void> {}
    }

    const result = await runFlow({
      driver: new FailingMockDriver(),
    });

    // Verify run failed
    expect(result.summary.status).toBe('failed');

    // Verify timeline has RunFailed instead of RunCompleted
    const timelineNames = result.timeline.map((t) => t.name);
    expect(timelineNames).toContain('RunFailed');
    expect(timelineNames).not.toContain('RunCompleted');

    // Verify checkpoint is still valid (checkpoint structure is valid, task failed)
    const checkpointPath = `.newide/runs/${result.run_id}/checkpoint.json`;
    const checkpointContent = await fs.readFile(checkpointPath, 'utf-8');
    const checkpoint = JSON.parse(checkpointContent);

    expect(checkpoint.validity_status).toBe('valid');
    expect(checkpoint.semantic_handoff.done).not.toContain('driver completed');
    expect(checkpoint.semantic_handoff.blocked_on).toContain('driver execution failed');

    const resultPath = `.newide/runs/${result.run_id}/result.json`;
    const manifest = JSON.parse(await fs.readFile(resultPath, 'utf-8'));
    expect(manifest.status).toBe('failed');
    expect(result.result_manifest.status).toBe('failed');
  });

  it('should use real mailbox send/ack mechanism', async () => {
    const result = await runFlow();

    // Verify mailbox fields exist in summary
    expect(result.summary.mailbox_message_refs).toBeInstanceOf(Array);
    expect(result.summary.mailbox_message_refs.length).toBe(3);
    expect(result.summary.mailbox_thread_id).toBe(result.run_id);

    // Verify timeline contains mailbox events
    const timelineNames = result.timeline.map((t) => t.name);
    expect(timelineNames).toContain('MailboxMessageSent (task.assigned)');
    expect(timelineNames).toContain('MailboxMessageSent (driver.requested)');
    expect(timelineNames).toContain('MailboxMessageSent (driver.completed)');
    expect(timelineNames).toContain('MailboxMessageAcked (driver.requested)');

    // Verify mailbox events appear in correct order
    const taskAssignedIndex = timelineNames.indexOf('MailboxMessageSent (task.assigned)');
    const driverRequestedIndex = timelineNames.indexOf('MailboxMessageSent (driver.requested)');
    const driverCompletedIndex = timelineNames.indexOf('MailboxMessageSent (driver.completed)');
    const driverAckedIndex = timelineNames.indexOf('MailboxMessageAcked (driver.requested)');

    expect(taskAssignedIndex).toBeGreaterThanOrEqual(0);
    expect(driverRequestedIndex).toBeGreaterThan(taskAssignedIndex);
    expect(driverCompletedIndex).toBeGreaterThan(driverRequestedIndex);
    expect(driverAckedIndex).toBeGreaterThan(driverRequestedIndex);
  });

  async function runFlow(options?: IntegrationV0Options): Promise<IntegrationV0Result> {
    const result = await runIntegrationV0Flow(options);
    createdRunDirs.add(`.newide/runs/${result.run_id}`);
    createdWorktreeDirs.add(result.materialization_result.worktree_path);
    return result;
  }
});

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, 'utf-8'));
}

function createArtifact(artifactId: string, type: ArtifactRef['type'] = 'patch'): ArtifactRef {
  return {
    artifact_id: artifactId,
    type,
    uri: `artifact://${type}/${artifactId}`,
    producer_id: 'agent-driver',
    task_id: 'task_001',
    created_at: '2026-07-07T00:00:00.000Z',
    schema_version: SCHEMA_VERSION,
  };
}
