import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { runIntegrationV0Flow } from '../../src/coordinator/integration-v0-flow';
import { MockDriver } from '../../src/driver';

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
});
