import { describe, expect, it } from 'vitest';
import type { IntegrationV0Result } from '../../src/coordinator/integration-v0-flow';
import { NewideBackendService } from '../../src/app/newide-backend-service';

describe('NewideBackendService', () => {
  it('returns real ids before the runner completes and records telemetry', async () => {
    let finish: ((result: IntegrationV0Result) => void) | undefined;
    const runnerResult = new Promise<IntegrationV0Result>((resolve) => {
      finish = resolve;
    });
    const service = new NewideBackendService({
      run: async (request) => {
        request.onRunCreated?.({ run_id: 'run_1', task_id: 'task_1' });
        await request.telemetry?.emit({
          telemetry_id: 'telemetry_1',
          event_type: 'driver.run_result',
          owner: 'B-owned-observed',
          subject_id: 'driver_result_1',
          run_id: 'run_1',
          task_id: 'task_1',
          payload: { status: 'succeeded' },
          created_at: '2026-07-11T08:00:00.000Z',
          schema_version: 'v0',
        });
        return runnerResult;
      },
    });

    await expect(service.createRun({ prompt: 'Build RPC' })).resolves.toEqual({
      run_id: 'run_1',
      task_id: 'task_1',
      status: 'running',
    });
    expect(service.getSnapshot('run_1')).toMatchObject({
      status: 'running',
      events: [
        { sequence: 1, type: 'run.started' },
        { sequence: 2, type: 'driver.run_result', payload: { status: 'succeeded' } },
      ],
    });

    finish?.(completedResult('run_1', 'task_1'));
    await viWaitFor(() => service.getSnapshot('run_1').status === 'completed');
    expect(service.getSnapshot('run_1')).toMatchObject({
      status: 'completed',
      snapshot: { run_id: 'run_1', task_id: 'task_1' },
      events: [{ sequence: 1 }, { sequence: 2 }, { sequence: 3, type: 'run.completed' }],
    });
  });

  it('records runner exceptions after identity as failed runs', async () => {
    const service = new NewideBackendService({
      run: async (request) => {
        request.onRunCreated?.({ run_id: 'run_failed', task_id: 'task_failed' });
        throw new Error('driver process exited');
      },
    });

    await service.createRun({ prompt: 'Fail safely', mode: 'council' });
    await viWaitFor(() => service.getSnapshot('run_failed').status === 'failed');
    expect(service.getSnapshot('run_failed')).toMatchObject({
      mode: 'council',
      error: { code: 'RUNNER_FAILED', message: 'driver process exited' },
    });
  });
});

async function viWaitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('condition was not met');
}

function completedResult(runId: string, taskId: string): IntegrationV0Result {
  return {
    run_id: runId,
    task_id: taskId,
    summary: { status: 'completed' },
    frontend_snapshot: {
      snapshot_type: 'coordinator.frontend_run_snapshot.v0',
      schema_version: 'v0',
      generated_at: '2026-07-11T08:00:00.000Z',
      run_id: runId,
      task_id: taskId,
      current: { stage: 'delivery', task_status: 'completed', active_node_code: 'N18' },
      run: {
        run_id: runId,
        task_id: taskId,
        status: 'completed',
        mode: 'single_agent',
        driver_id: 'mock-driver',
        created_at: '2026-07-11T08:00:00.000Z',
      },
      flow: { active_node_code: 'N18', node_statuses: [] },
      timeline: [],
      delivery_report: {
        worktree_path: '.newide/worktrees/task_1',
        files_written: [],
        artifacts_materialized: 0,
        driver_diagnostics: { driver_id: 'mock-driver', duration_ms: 1 },
      },
      artifacts: [],
      checkpoint: {} as never,
      mailbox: { thread_id: runId, message_refs: [], messages: [] },
      links: {} as never,
    },
  } as IntegrationV0Result;
}
