import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IntegrationV0Result } from '../../src/coordinator/integration-v0-flow';
import { NewideBackendService } from '../../src/app/newide-backend-service';
import { InMemoryRunRegistry } from '../../src/app/run-registry';
import { FileRunAuditWriter } from '../../src/app/run-audit-writer';
import { FileRunTerminalOutputWriter } from '../../src/app/run-terminal-output-writer';
import { IntegrationV0CoordinatorRunner } from '../../src/coordinator/coordinator-runner';
import { runSnapshotSchema } from '../../src/protocol/run-snapshot';

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

  it('projects coordinator domain events without duplicating event-store telemetry', async () => {
    const service = new NewideBackendService({
      run: async (request) => {
        request.onEvent?.({
          event_id: 'event_task_created',
          event_type: 'task.created',
          subject_id: 'task_domain',
          task_id: 'task_domain',
          payload: { spec: 'Project events' },
          created_at: '2026-07-11T08:00:00.000Z',
          schema_version: 'v0',
        });
        request.onRunCreated?.({ run_id: 'run_domain', task_id: 'task_domain' });
        request.onEvent?.({
          event_id: 'event_artifact',
          event_type: 'artifact.registered',
          subject_id: 'artifact_1',
          run_id: 'run_domain',
          task_id: 'task_domain',
          payload: { type: 'patch' },
          created_at: '2026-07-11T08:00:01.000Z',
          schema_version: 'v0',
        });
        await request.telemetry?.emit({
          telemetry_id: 'telemetry_duplicate',
          event_type: 'task.created',
          owner: 'C-owned-observed',
          subject_id: 'task_domain',
          run_id: 'run_domain',
          task_id: 'task_domain',
          payload: { spec: 'Project events' },
          source: { kind: 'event_store', event_id: 'event_task_created' },
          created_at: '2026-07-11T08:00:00.000Z',
          schema_version: 'v0',
        });
        return new Promise<IntegrationV0Result>(() => undefined);
      },
    });

    await service.createRun({ prompt: 'Project events' });

    expect(service.getSnapshot('run_domain').events).toMatchObject([
      { event_id: 'event_task_created', type: 'task.created', source: 'coordinator' },
      { type: 'run.started', source: 'coordinator' },
      { event_id: 'event_artifact', type: 'artifact.registered', source: 'coordinator' },
    ]);
  });

  it('cancels the runner without replacing cancelled state with failure', async () => {
    let receivedSignal: AbortSignal | undefined;
    const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'backend-service-'));
    const service = new NewideBackendService(
      {
        run: async (request) => {
          receivedSignal = request.signal;
          request.onRunCreated?.({ run_id: 'run_cancelled', task_id: 'task_cancelled' });
          await new Promise((_, reject) => {
            request.signal?.addEventListener('abort', () => reject(request.signal?.reason), {
              once: true,
            });
          });
          throw new Error('unreachable');
        },
      },
      new InMemoryRunRegistry(),
      new FileRunAuditWriter(runsRoot),
      new FileRunTerminalOutputWriter(runsRoot),
    );

    try {
      await service.createRun({ prompt: 'Cancel safely' });
      await expect(service.cancelRun('run_cancelled')).resolves.toEqual({ cancelled: true });
      expect(receivedSignal?.aborted).toBe(true);
      await viWaitFor(() => service.getSnapshot('run_cancelled').status === 'cancelled');
      expect(service.getSnapshot('run_cancelled')).toMatchObject({
        status: 'cancelled',
        events: [{ type: 'run.started' }, { type: 'run.cancelled' }],
      });
      expect(service.getRunSnapshot('run_cancelled')).toMatchObject({
        status: 'cancelled',
        timeline: [{ type: 'run.started' }, { type: 'run.cancelled' }],
        agent_runs: [],
        artifacts: [],
        gates: [],
        errors: [],
        final_output: { status: 'cancelled' },
      });
      const audit = (await readFile(path.join(runsRoot, 'run_cancelled', 'audit.jsonl'), 'utf-8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(audit.map((event) => event.type)).toEqual(['run.started', 'run.cancelled']);
      await expect(
        readJson(path.join(runsRoot, 'run_cancelled', 'result.json')),
      ).resolves.toMatchObject({
        run_id: 'run_cancelled',
        task_id: 'task_cancelled',
        status: 'cancelled',
      });
      await expect(
        readJson(path.join(runsRoot, 'run_cancelled', 'frontend-snapshot.json')),
      ).resolves.toMatchObject({ status: 'cancelled' });
    } finally {
      await rm(runsRoot, { recursive: true, force: true });
    }
  });

  it('projects a real council run into snapshot and append-only audit events', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'backend-integration-events-'));
    const auditWriter = new FileRunAuditWriter(path.join(tempRoot, 'runs'));
    const service = new NewideBackendService(
      new IntegrationV0CoordinatorRunner({ worktreePath: path.join(tempRoot, 'worktrees') }),
      new InMemoryRunRegistry(),
      auditWriter,
      new FileRunTerminalOutputWriter(path.join(tempRoot, 'runs')),
    );
    let runId: string | undefined;

    try {
      const created = await service.createRun({
        prompt: 'Project the real Council event flow',
        mode: 'council',
      });
      runId = created.run_id;
      await viWaitFor(() => service.getSnapshot(created.run_id).status === 'completed');
      await auditWriter.flush(created.run_id);

      const types = service.getSnapshot(created.run_id).events.map((event) => event.type);
      expect(types).toEqual(
        expect.arrayContaining([
          'task.created',
          'run.created',
          'driver.session_started',
          'driver.run_result',
          'artifact.registered',
          'gate.result',
          'council.started',
          'council.decision',
          'council.completed',
          'checkpoint.saved',
          'run.completed',
        ]),
      );
      expect(types.filter((type) => type === 'run.completed')).toHaveLength(1);

      const externalSnapshot = service.getRunSnapshot(created.run_id);
      expect(externalSnapshot).toMatchObject({
        mode: 'council',
        status: 'completed',
        council: {
          enabled: true,
          status: 'completed',
          verdict: 'select',
          can_create_merge_authorization: false,
        },
        final_output: { status: 'completed' },
      });
      expect(externalSnapshot.artifacts.length).toBeGreaterThan(0);
      expect(externalSnapshot.gates.length).toBeGreaterThan(0);
      expect(externalSnapshot.checkpoint).toBeDefined();
      expect(runSnapshotSchema.parse(externalSnapshot)).toEqual(externalSnapshot);

      const audit = (
        await readFile(path.join(tempRoot, 'runs', created.run_id, 'audit.jsonl'), 'utf-8')
      )
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(audit.map((event) => event.type)).toEqual(types);
    } finally {
      if (runId) await rm(path.join('.newide/runs', runId), { recursive: true, force: true });
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

async function viWaitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
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

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, 'utf-8'));
}
