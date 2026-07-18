import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, type Event, type TaskCreateRequest } from '../../src/core';
import { TaskProcessor } from '../../src/app/task-processor';
import { SqliteCoordinationStore } from '../../src/persistence';
import type { RunSnapshot } from '../../src/protocol/run-snapshot';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('TaskProcessor', () => {
  it('begins a run and advances only through finite resume cursors', () => {
    const { processor, store } = createProcessor();
    const started = processor.beginRun({
      task_id: 'task_processor',
      run_id: 'run_processor',
      task_request: taskRequest,
      workspace_path: '/workspace',
      mode: 'single_agent',
    });

    expect(started).toMatchObject({
      task: { task_id: 'task_processor', status: 'running' },
      current_run: { run_id: 'run_processor', status: 'running' },
    });
    expect(store.getTaskAggregate('task_processor')?.runtime_state.resume_cursor).toBe(
      'select_agent',
    );

    processor.recordRunEvent(
      'run_processor',
      event('event_market', 'market.selected', {
        winner_agent_id: 'role_ts_engineer',
      }),
    );
    expect(store.getTaskAggregate('task_processor')).toMatchObject({
      task: { owner_agent_id: 'role_ts_engineer' },
      runtime_state: { resume_cursor: 'execute_agent' },
      events: [
        { event_type: 'task.created' },
        { event_type: 'run.created' },
        { event_type: 'run.started' },
        { event_id: 'event_market', event_type: 'market.selected' },
      ],
    });

    processor.recordRunEvent(
      'run_processor',
      event('event_agent_done', 'agent.execution_completed'),
    );
    expect(store.getTaskAggregate('task_processor')?.runtime_state.resume_cursor).toBe('gate');
    store.close();
  });

  it('persists a completed snapshot that survives a new processor instance', () => {
    const { databasePath, processor, store } = createProcessor();
    processor.beginRun({
      task_id: 'task_restart',
      run_id: 'run_restart',
      task_request: taskRequest,
      workspace_path: '/workspace',
      mode: 'single_agent',
    });

    const completed = processor.finishRun({
      run_id: 'run_restart',
      status: 'completed',
      snapshot: terminalSnapshot('run_restart', 'task_restart', 'single_agent'),
      final_output: {
        artifact_ref: 'artifact_final',
        sha256: 'b'.repeat(64),
        workspace_path: '/workspace/result.ts',
      },
    });
    expect(completed).toMatchObject({
      task: { status: 'completed' },
      run_history: [{ run_id: 'run_restart', status: 'completed' }],
      final_output: {
        artifact_refs: ['artifact_final'],
        files_written: ['/workspace/result.ts'],
      },
    });
    expect(completed.current_run).toBeUndefined();
    store.close();

    const reopenedStore = new SqliteCoordinationStore(databasePath);
    const restartedProcessor = new TaskProcessor(reopenedStore, deterministicClock());
    expect(restartedProcessor.getTaskSnapshot('task_restart')).toEqual(completed);
    reopenedStore.close();
  });

  it('starts a Council run under the same completed Task without duplicating the Task', () => {
    const { processor, store } = createProcessor();
    processor.beginRun({
      task_id: 'task_council',
      run_id: 'run_first',
      task_request: taskRequest,
      workspace_path: '/workspace',
      mode: 'single_agent',
    });
    processor.finishRun({
      run_id: 'run_first',
      status: 'completed',
      snapshot: terminalSnapshot('run_first', 'task_council', 'single_agent'),
      final_output: {
        artifact_ref: 'artifact_first',
        sha256: 'c'.repeat(64),
        workspace_path: '/workspace/result.ts',
      },
    });

    const council = processor.beginRun({
      task_id: 'task_council',
      run_id: 'run_council',
      task_request: taskRequest,
      workspace_path: '/workspace',
      mode: 'council',
    });

    expect(council).toMatchObject({
      task: { task_id: 'task_council', status: 'running' },
      current_run: { run_id: 'run_council', mode: 'council', status: 'running' },
      run_history: [{ run_id: 'run_first', status: 'completed' }],
    });
    expect(store.listTaskAggregates()).toHaveLength(1);
    expect(store.getTaskAggregate('task_council')?.runtime_state).toMatchObject({
      current_run_id: 'run_council',
      resume_cursor: 'execute_agent',
    });
    store.close();
  });
});

const taskRequest: TaskCreateRequest = {
  spec: 'Persist the Task processor lifecycle',
  role_id: 'role_ts_engineer',
  risk_level: 'medium',
  affected_paths: ['src/app/**'],
  completion_criteria: ['State survives restart'],
};

function createProcessor(): {
  databasePath: string;
  store: SqliteCoordinationStore;
  processor: TaskProcessor;
} {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'newide-task-processor-'));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, 'coordination.sqlite');
  const store = new SqliteCoordinationStore(databasePath);
  return {
    databasePath,
    store,
    processor: new TaskProcessor(store, deterministicClock()),
  };
}

function deterministicClock(): {
  now: () => string;
  createEventId: () => string;
} {
  let sequence = 0;
  return {
    now: () => `2026-07-19T03:00:${String(sequence).padStart(2, '0')}.000Z`,
    createEventId: () => `processor_event_${String(++sequence)}`,
  };
}

function event(eventId: string, eventType: string, payload: Record<string, unknown> = {}): Event {
  return {
    event_id: eventId,
    event_type: eventType,
    subject_id: 'run_processor',
    run_id: 'run_processor',
    task_id: 'task_processor',
    payload,
    created_at: '2026-07-19T03:01:00.000Z',
    schema_version: SCHEMA_VERSION,
  };
}

function terminalSnapshot(
  runId: string,
  taskId: string,
  mode: 'single_agent' | 'council',
): RunSnapshot {
  return {
    schema_version: SCHEMA_VERSION,
    run_id: runId,
    task_id: taskId,
    mode,
    status: 'completed',
    current: { stage: 'delivery', active_node_code: 'N18' },
    run: {
      run_id: runId,
      task_id: taskId,
      status: 'completed',
      mode,
      session_id: 'session_restart',
      event_ids: [],
      started_at: '2026-07-19T03:00:00.000Z',
      completed_at: '2026-07-19T03:02:00.000Z',
    },
    timeline: [],
    agent_runs: [],
    artifacts: [{ artifact_id: 'artifact_final' }],
    gates: [],
    errors: [],
    final_output: {
      status: 'completed',
      artifact_refs: ['artifact_final'],
      files_written: ['/workspace/result.ts'],
      changed_files: ['result.ts'],
      session_id: 'session_restart',
    },
  };
}
