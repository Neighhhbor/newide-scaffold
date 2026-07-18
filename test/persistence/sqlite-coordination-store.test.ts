import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SqliteCoordinationStore,
  type CoordinationStateCommit,
} from '../../src/persistence/sqlite-coordination-store';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('SqliteCoordinationStore', () => {
  it('creates the v1 coordination schema in WAL mode', () => {
    const { databasePath, store } = createStore();
    store.close();

    const database = new DatabaseSync(databasePath);
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => String(row.name));
    const journalMode = database.prepare('PRAGMA journal_mode').get();
    const migration = database
      .prepare('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1')
      .get();
    database.close();

    expect(tables).toEqual(
      expect.arrayContaining([
        'tasks',
        'runs',
        'task_runtime_states',
        'events',
        'checkpoints',
        'messages',
        'deliveries',
      ]),
    );
    expect(journalMode).toEqual({ journal_mode: 'wal' });
    expect(migration).toEqual({ version: 1 });
  });

  it('atomically persists task, run, runtime state, and ordered events', () => {
    const { store } = createStore();
    const commit = initialCommit();

    const [event] = store.commitState(commit);
    const aggregate = store.getTaskAggregate('task_sqlite');

    expect(event).toMatchObject({ sequence: 1, event_id: 'event_task_created' });
    expect(aggregate).toEqual({
      task: commit.task,
      runs: [commit.run],
      runtime_state: commit.runtime_state,
      events: [expect.objectContaining({ sequence: 1, event_id: 'event_task_created' })],
    });
    store.close();
  });

  it('rolls back state changes when the event write fails', () => {
    const { store } = createStore();
    const initial = initialCommit();
    store.commitState(initial);

    expect(() =>
      store.commitState({
        expected_task_revision: 1,
        task: {
          ...initial.task,
          status: 'running',
          revision: 2,
          updated_at: '2026-07-19T02:01:00.000Z',
        },
        run: {
          ...initial.run,
          status: 'running',
          revision: 2,
          updated_at: '2026-07-19T02:01:00.000Z',
        },
        runtime_state: {
          ...initial.runtime_state,
          resume_cursor: 'execute_agent',
          updated_at: '2026-07-19T02:01:00.000Z',
        },
        events: [initial.events[0]],
      }),
    ).toThrow();

    const aggregate = store.getTaskAggregate('task_sqlite');
    expect(aggregate?.task).toMatchObject({ status: 'created', revision: 1 });
    expect(aggregate?.runs[0]).toMatchObject({ status: 'created', revision: 1 });
    expect(aggregate?.runtime_state.resume_cursor).toBe('select_agent');
    expect(aggregate?.events).toHaveLength(1);
    store.close();
  });

  it('rejects a second active run for the same task', () => {
    const { store } = createStore();
    const initial = initialCommit();
    store.commitState(initial);

    expect(() =>
      store.commitState({
        expected_task_revision: 1,
        task: {
          ...initial.task,
          status: 'running',
          revision: 2,
          updated_at: '2026-07-19T02:01:00.000Z',
        },
        run: {
          ...initial.run,
          run_id: 'run_second',
          status: 'running',
          revision: 1,
          updated_at: '2026-07-19T02:01:00.000Z',
        },
        runtime_state: {
          ...initial.runtime_state,
          current_run_id: 'run_second',
          updated_at: '2026-07-19T02:01:00.000Z',
        },
        events: [
          {
            event_id: 'event_second_run',
            event_type: 'run.started',
            subject_id: 'run_second',
            run_id: 'run_second',
            task_id: 'task_sqlite',
            payload: {},
            created_at: '2026-07-19T02:01:00.000Z',
            schema_version: 'v0',
          },
        ],
      }),
    ).toThrow(/active run/i);

    expect(store.getTaskAggregate('task_sqlite')?.runs).toHaveLength(1);
    store.close();
  });

  it('requires verifiable final artifact evidence before completing a task', () => {
    const { store } = createStore();
    const initial = initialCommit();
    store.commitState(initial);

    const completed: CoordinationStateCommit = {
      expected_task_revision: 1,
      task: {
        ...initial.task,
        status: 'completed',
        revision: 2,
        updated_at: '2026-07-19T02:02:00.000Z',
      },
      run: {
        ...initial.run,
        status: 'completed',
        revision: 2,
        completed_at: '2026-07-19T02:02:00.000Z',
        updated_at: '2026-07-19T02:02:00.000Z',
      },
      runtime_state: {
        ...initial.runtime_state,
        current_run_id: undefined,
        resume_cursor: 'done',
        updated_at: '2026-07-19T02:02:00.000Z',
      },
      events: [
        {
          event_id: 'event_completed',
          event_type: 'task.completed',
          subject_id: 'task_sqlite',
          run_id: 'run_sqlite',
          task_id: 'task_sqlite',
          payload: {},
          created_at: '2026-07-19T02:02:00.000Z',
          schema_version: 'v0',
        },
      ],
    };

    expect(() => store.commitState(completed)).toThrow(/final artifact/i);

    store.commitState({
      ...completed,
      task: {
        ...completed.task,
        final_output: {
          artifact_ref: 'artifact_final',
          sha256: 'a'.repeat(64),
          workspace_path: '/workspace/result.ts',
        },
      },
    });
    expect(store.getTaskAggregate('task_sqlite')?.task).toMatchObject({
      status: 'completed',
      final_output: { artifact_ref: 'artifact_final', sha256: 'a'.repeat(64) },
    });
    store.close();
  });
});

function createStore(): { databasePath: string; store: SqliteCoordinationStore } {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'newide-coordination-store-'));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, 'coordination.sqlite');
  return { databasePath, store: new SqliteCoordinationStore(databasePath) };
}

function initialCommit(): CoordinationStateCommit {
  return {
    task: {
      task_id: 'task_sqlite',
      status: 'created',
      risk_level: 'medium',
      spec: 'Persist one task atomically',
      completion_criteria: ['Task and Event commit together'],
      affected_paths: ['src/persistence/**'],
      workspace_path: '/workspace',
      warnings: [],
      revision: 1,
      created_at: '2026-07-19T02:00:00.000Z',
      updated_at: '2026-07-19T02:00:00.000Z',
      schema_version: 'v0',
    },
    run: {
      run_id: 'run_sqlite',
      task_id: 'task_sqlite',
      status: 'created',
      mode: 'single_agent',
      workspace_path: '/workspace',
      revision: 1,
      created_at: '2026-07-19T02:00:00.000Z',
      updated_at: '2026-07-19T02:00:00.000Z',
      schema_version: 'v0',
    },
    runtime_state: {
      task_id: 'task_sqlite',
      current_run_id: 'run_sqlite',
      resume_cursor: 'select_agent',
      waiting_on: [],
      artifact_refs: [],
      diagnostics: {},
      updated_at: '2026-07-19T02:00:00.000Z',
      schema_version: 'v0',
    },
    events: [
      {
        event_id: 'event_task_created',
        event_type: 'task.created',
        subject_id: 'task_sqlite',
        run_id: 'run_sqlite',
        task_id: 'task_sqlite',
        payload: { spec: 'Persist one task atomically' },
        created_at: '2026-07-19T02:00:00.000Z',
        schema_version: 'v0',
      },
    ],
  };
}
