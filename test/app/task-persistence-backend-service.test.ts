import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileRunAuditWriter } from '../../src/app/run-audit-writer';
import { InMemoryRunRegistry } from '../../src/app/run-registry';
import type { AppRunEvent } from '../../src/app/run-registry';
import { FileRunRequestStore } from '../../src/app/run-request-store';
import { NewideBackendService } from '../../src/app/newide-backend-service';
import { TaskProcessor } from '../../src/app/task-processor';
import { FileRunTerminalOutputWriter } from '../../src/app/run-terminal-output-writer';
import type { CoordinatorRunner } from '../../src/coordinator/coordinator-runner';
import type { IntegrationV0Result } from '../../src/coordinator/integration-v0-flow';
import { SqliteCoordinationStore } from '../../src/persistence';

describe('NewideBackendService SQLite lifecycle', () => {
  it('queries the same completed Task and Run after reconstructing the backend service', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'newide-service-sqlite-'));
    const runsRoot = path.join(root, 'runs');
    const databasePath = path.join(root, 'coordination.sqlite');
    const requestStore = new FileRunRequestStore(runsRoot);
    const firstStore = new SqliteCoordinationStore(databasePath);
    const firstProcessor = new TaskProcessor(firstStore);
    const service = createService(firstProcessor, requestStore, runsRoot, completedRunner());

    try {
      const created = await service.createTask({
        spec: 'Persist the backend lifecycle',
        completion_criteria: ['A restarted backend returns the same TaskSnapshot'],
        workspace_path: root,
      });
      await service.waitForTerminal(created.current_run!.run_id);
      const completed = await service.getTask(created.task.task_id);
      expect(completed).toMatchObject({
        task: { status: 'completed' },
        run_history: [{ status: 'completed' }],
        market: { winner_agent_id: 'role_ts_engineer' },
        final_output: { artifact_refs: ['artifact_persisted'] },
      });
      const persisted = firstStore.getTaskAggregate(created.task.task_id);
      expect(persisted).toMatchObject({
        task: {
          status: 'completed',
          final_output: {
            artifact_ref: expect.stringMatching(/^file:/),
            sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
        },
        runtime_state: { resume_cursor: 'done' },
      });
      expect(persisted?.runtime_state).not.toHaveProperty('current_run_id');
      firstStore.close();

      const reopenedStore = new SqliteCoordinationStore(databasePath);
      const restarted = createService(new TaskProcessor(reopenedStore), requestStore, runsRoot, {
        run: async () => {
          throw new Error('Restart query must not execute a new run');
        },
      });
      try {
        await expect(restarted.getTask(created.task.task_id)).resolves.toEqual(completed);
        expect(restarted.getRunSnapshot(completed.run_history[0]!.run_id)).toMatchObject({
          status: 'completed',
          final_output: { artifact_refs: ['artifact_persisted'] },
        });
        const firstEventId = reopenedStore.getTaskAggregate(created.task.task_id)?.events[0]
          ?.event_id;
        expect(firstEventId).toBeDefined();
        const subscription = await restarted.subscribeTask(
          created.task.task_id,
          () => undefined,
          firstEventId,
        );
        expect(subscription.replay_events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ event_id: 'event_market_persisted' }),
            expect.objectContaining({ type: 'run.completed' }),
          ]),
        );
        subscription.unsubscribe();
      } finally {
        reopenedStore.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps legacy file Tasks readable and adopts their next Council run into SQLite', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'newide-service-legacy-'));
    const runsRoot = path.join(root, 'runs');
    const requestStore = new FileRunRequestStore(runsRoot);
    const legacy = new NewideBackendService(
      completedRunner(),
      new InMemoryRunRegistry(),
      new FileRunAuditWriter(runsRoot),
      new FileRunTerminalOutputWriter(runsRoot),
      requestStore,
    );

    try {
      const created = await legacy.createTask({
        spec: 'Persist the backend lifecycle',
        completion_criteria: ['A restarted backend returns the same TaskSnapshot'],
        workspace_path: root,
      });
      await legacy.waitForTerminal(created.current_run!.run_id);

      const store = new SqliteCoordinationStore(path.join(root, 'new-coordination.sqlite'));
      const service = createService(new TaskProcessor(store), requestStore, runsRoot, {
        run: async (request) => {
          request.onRunCreated?.({
            run_id: 'run_legacy_council',
            task_id: request.task_id ?? 'wrong_task',
          });
          return new Promise<IntegrationV0Result>(() => undefined);
        },
      });
      try {
        await expect(service.getTask(created.task.task_id)).resolves.toMatchObject({
          task: { status: 'completed' },
        });
        const taskEvents: AppRunEvent[] = [];
        const subscription = await service.subscribeTask(created.task.task_id, (event) =>
          taskEvents.push(event),
        );
        const council = await service.startCouncil(created.task.task_id);
        expect(council).toMatchObject({
          task: { task_id: created.task.task_id, status: 'running' },
          current_run: { run_id: 'run_legacy_council', mode: 'council' },
          run_history: [],
        });
        expect(store.getTaskAggregate(created.task.task_id)).toBeDefined();
        const started = taskEvents.find((event) => event.type === 'run.started');
        expect(started).toBeDefined();
        expect(
          store
            .getTaskAggregate(created.task.task_id)
            ?.events.some((event) => event.event_id === started?.event_id),
        ).toBe(true);
        subscription.unsubscribe();
      } finally {
        store.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function createService(
  processor: TaskProcessor,
  requestStore: FileRunRequestStore,
  runsRoot: string,
  runner: CoordinatorRunner,
): NewideBackendService {
  return new NewideBackendService(
    runner,
    new InMemoryRunRegistry(),
    new FileRunAuditWriter(runsRoot),
    new FileRunTerminalOutputWriter(runsRoot),
    requestStore,
    processor,
  );
}

function completedRunner(): CoordinatorRunner {
  return {
    run: async (request) => {
      request.onEvent?.({
        event_id: 'event_task_persisted',
        event_type: 'task.created',
        subject_id: 'task_persisted',
        task_id: 'task_persisted',
        payload: { spec: request.prompt },
        created_at: '2026-07-19T04:00:00.000Z',
        schema_version: 'v0',
      });
      request.onRunCreated?.({ run_id: 'run_persisted', task_id: 'task_persisted' });
      request.onEvent?.({
        event_id: 'event_market_persisted',
        event_type: 'market.selected',
        subject_id: 'role_ts_engineer',
        run_id: 'run_persisted',
        task_id: 'task_persisted',
        payload: {
          winner_agent_id: 'role_ts_engineer',
          winner_bid_id: 'bid_persisted',
          ledger_ref: 'file:///market/ledger.json',
          audit_ref: 'file:///market/audit.json',
          policy_version: 'market-v0',
          seed: 'run_persisted',
        },
        created_at: '2026-07-19T04:00:01.000Z',
        schema_version: 'v0',
      });
      return completedResult(request.prompt);
    },
  };
}

function completedResult(spec: string): IntegrationV0Result {
  return {
    run_id: 'run_persisted',
    task_id: 'task_persisted',
    summary: { status: 'completed' },
    frontend_snapshot: {
      snapshot_type: 'coordinator.frontend_run_snapshot.v0',
      schema_version: 'v0',
      generated_at: '2026-07-19T04:01:00.000Z',
      run_id: 'run_persisted',
      task_id: 'task_persisted',
      task: {
        task_id: 'task_persisted',
        status: 'completed',
        spec,
        completion_criteria: ['A restarted backend returns the same TaskSnapshot'],
        risk_level: 'low',
        affected_paths: [],
        created_at: '2026-07-19T04:00:00.000Z',
        updated_at: '2026-07-19T04:01:00.000Z',
        schema_version: 'v0',
      },
      current: { stage: 'delivery', task_status: 'completed', active_node_code: 'N18' },
      run: {
        run_id: 'run_persisted',
        task_id: 'task_persisted',
        status: 'completed',
        mode: 'single_agent',
        driver_id: 'fake-driver',
        session_id: 'session_persisted',
        created_at: '2026-07-19T04:00:00.000Z',
      },
      flow: { active_node_code: 'N18', node_statuses: [] },
      timeline: [],
      delivery_report: {
        worktree_path: '/workspace',
        files_written: ['/workspace/result.ts'],
        changed_files: ['result.ts'],
        artifacts_materialized: 1,
        outcome: 'completed_files',
        session_id: 'session_persisted',
        tool_events: [],
        driver_diagnostics: { driver_id: 'fake-driver', duration_ms: 1 },
      },
      artifacts: [{ artifact_id: 'artifact_persisted' } as never],
      checkpoint: {} as never,
      mailbox: { thread_id: 'run_persisted', message_refs: [], messages: [] },
      market: {
        winner_agent_id: 'role_ts_engineer',
        winner_bid_id: 'bid_persisted',
        ledger_ref: 'file:///market/ledger.json',
        audit_ref: 'file:///market/audit.json',
        policy_version: 'market-v0',
        seed: 'run_persisted',
      },
      links: {} as never,
    },
  } as IntegrationV0Result;
}
