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

    expect(result.summary.mode).toBe('council');
    expect(result.summary.status).toBe('completed');
    expect(result.selection_result.council_decision).toMatchObject({
      run_id: result.run_id,
      task_id: result.task_id,
      decision_mode: 'advisory',
      verdict: 'select',
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
      frontend_snapshot_path: `.newide/runs/${result.run_id}/frontend-snapshot.json`,
      schema_version: result.summary.schema_version,
    });
    expect(manifest.created_at).toBeDefined();
    await expect(readJson(manifest.summary_path)).resolves.toMatchObject({
      run_id: result.run_id,
    });
    await expect(readJson(manifest.timeline_path)).resolves.toEqual(expect.any(Array));
    await expect(readJson(manifest.checkpoint_path)).resolves.toMatchObject({
      checkpoint_id: result.summary.checkpoint_id,
    });
    await expect(readJson(manifest.message_thread_path)).resolves.toEqual(result.mailbox_thread);
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
