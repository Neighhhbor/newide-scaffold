import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { runIntegrationV0Flow } from '../../src/coordinator/integration-v0-flow';
import {
  MockDriver,
  type DriverRuntimeHandle,
  type DriverPrompt,
  type DriverRunResult,
} from '../../src/driver';
import { createId } from '../../src/core';

describe('runIntegrationV0Flow', () => {
  afterEach(async () => {
    // Clean up .newide/runs/ and .newide/worktrees/ test directories
    try {
      await fs.rm('.newide/runs', { recursive: true, force: true });
      await fs.rm('.newide/worktrees', { recursive: true, force: true });
    } catch {
      // Ignore if doesn't exist
    }
  });

  it('should run complete flow with MockDriver and single_agent mode', async () => {
    const result = await runIntegrationV0Flow();

    expect(result.run_id).toBeDefined();
    expect(result.task_id).toBeDefined();
    expect(result.summary.mode).toBe('single_agent');
    expect(result.summary.status).toBe('completed');

    // Verify mailbox events in timeline
    const timelineNames = result.timeline.map((t) => t.name);
    expect(timelineNames).toContain('task.assigned');
    expect(timelineNames).toContain('driver.requested');
    expect(timelineNames).toContain('driver.completed');
  });

  it('should run with council mode when enabled', async () => {
    const result = await runIntegrationV0Flow({ enableCouncil: true });

    expect(result.summary.mode).toBe('council');
    expect(result.summary.status).toBe('completed');
  });

  it('should persist summary and timeline to .newide/runs/', async () => {
    const result = await runIntegrationV0Flow();

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

  it('should materialize artifacts to worktree', async () => {
    const result = await runIntegrationV0Flow();

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

  it('should work with injected driver', async () => {
    const fakeDriver = new MockDriver();
    const result = await runIntegrationV0Flow({ driver: fakeDriver });

    expect(result.summary.status).toBe('completed');
    expect(result.driver_result.diagnostics.driver_id).toBe('mock-driver');
  });

  it('should include all key timeline events', async () => {
    const result = await runIntegrationV0Flow();

    const timelineNames = result.timeline.map((t) => t.name);

    // Core events
    expect(timelineNames).toContain('TaskCreated');
    expect(timelineNames).toContain('RunCreated');

    // Mailbox events
    expect(timelineNames).toContain('task.assigned');
    expect(timelineNames).toContain('driver.requested');
    expect(timelineNames).toContain('driver.completed');

    // Processing events
    expect(timelineNames).toContain('ContextPackBuilt');
    expect(timelineNames).toContain('DriverRunResult');
    expect(timelineNames).toContain('ArtifactSelected');
    expect(timelineNames).toContain('WorktreeMaterialized');
    expect(timelineNames).toContain('RunCompleted');
  });

  it('should create summary with correct structure', async () => {
    const result = await runIntegrationV0Flow();

    expect(result.summary).toHaveProperty('run_id');
    expect(result.summary).toHaveProperty('task_id');
    expect(result.summary).toHaveProperty('mode');
    expect(result.summary).toHaveProperty('status');
    expect(result.summary).toHaveProperty('worktree_path');
    expect(result.summary).toHaveProperty('artifacts_materialized');
    expect(result.summary).toHaveProperty('files_written');
    expect(result.summary).toHaveProperty('driver_diagnostics');
    expect(result.summary).toHaveProperty('created_at');
    expect(result.summary).toHaveProperty('schema_version');

    expect(result.summary.driver_diagnostics).toHaveProperty('driver_id');
    expect(result.summary.driver_diagnostics).toHaveProperty('duration_ms');
  });

  it('should support custom driver prompt', async () => {
    const customPrompt = 'Custom integration test prompt';
    const result = await runIntegrationV0Flow({ driverPrompt: customPrompt });

    expect(result.summary.status).toBe('completed');
    // Verify the prompt was used (indirectly through successful completion)
    expect(result.timeline.length).toBeGreaterThan(0);
  });

  it('should save checkpoint to .newide/runs/<run_id>/checkpoint.json', async () => {
    const result = await runIntegrationV0Flow();

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
    const result = await runIntegrationV0Flow();

    expect(result.summary.checkpoint_id).toBeDefined();
    expect(result.summary.checkpoint_path).toBe(`.newide/runs/${result.run_id}/checkpoint.json`);

    // Verify checkpoint_id matches the saved checkpoint
    const checkpointPath = result.summary.checkpoint_path;
    const checkpointContent = await fs.readFile(checkpointPath, 'utf-8');
    const checkpoint = JSON.parse(checkpointContent);

    expect(checkpoint.checkpoint_id).toBe(result.summary.checkpoint_id);
  });

  it('should include CheckpointSaved in timeline', async () => {
    const result = await runIntegrationV0Flow();

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
    const result = await runIntegrationV0Flow();

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
            schema_version: '1.0',
          },
          tool_events: [],
          diagnostics: {
            driver_id: this.driver_id,
            duration_ms: 100,
            exit_code: 1,
            notes: ['Driver failed intentionally'],
          },
          created_at: new Date().toISOString(),
          schema_version: '1.0',
        };
      }

      async collectTranscript(
        taskId: string,
      ): Promise<{
        artifact_id: string;
        type: string;
        uri: string;
        sha256: string;
        producer_id: string;
        task_id: string;
        created_at: string;
        schema_version: string;
      }> {
        return {
          artifact_id: createId('artifact'),
          type: 'transcript',
          uri: 'artifact://transcript/failing',
          sha256: 'mock-sha256',
          producer_id: this.driver_id,
          task_id: taskId,
          created_at: new Date().toISOString(),
          schema_version: '1.0',
        };
      }

      async interrupt(): Promise<void> {}

      async close(): Promise<void> {}
    }

    const result = await runIntegrationV0Flow({
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
  });
});
