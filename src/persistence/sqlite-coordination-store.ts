import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { SCHEMA_VERSION, TASK_STATUSES, type Event } from '../core';
import {
  type CoordinationStateCommit,
  type CoordinationStateStore,
  type PersistedCoordinationEvent,
  type PersistedRunState,
  type PersistedTaskAggregate,
  type PersistedTaskRuntimeState,
  type PersistedTaskState,
  type TaskResumeCursor,
} from './coordination-state-store';

const RUN_STATUSES = [
  'created',
  'running',
  'interrupted',
  'completed',
  'failed',
  'cancelled',
] as const;

const RUN_MODES = ['single_agent', 'council'] as const;
const RESUME_CURSORS = [
  'select_agent',
  'execute_agent',
  'council',
  'gate',
  'deliver',
  'mailbox_wait',
  'done',
] as const;

type SqlRow = Record<string, unknown>;

export class SqliteCoordinationStore implements CoordinationStateStore {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    if (databasePath !== ':memory:') mkdirSync(path.dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.configure();
    this.migrate();
  }

  commitState(input: CoordinationStateCommit): PersistedCoordinationEvent[] {
    validateCommit(input);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.writeTask(input);
      if (input.run) this.writeRun(input.run);
      this.writeRuntimeState(input.runtime_state);
      const events = input.events.map((event) => this.writeEvent(event));
      this.database.exec('COMMIT');
      return events;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  getTaskAggregate(taskId: string): PersistedTaskAggregate | undefined {
    const taskRow = this.database.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);
    if (!taskRow) return undefined;
    const runtimeRow = this.database
      .prepare('SELECT * FROM task_runtime_states WHERE task_id = ?')
      .get(taskId);
    if (!runtimeRow) throw new Error(`Task ${taskId} has no runtime state`);
    const runs = this.database
      .prepare('SELECT * FROM runs WHERE task_id = ? ORDER BY created_at DESC, run_id DESC')
      .all(taskId)
      .map((row) => readRun(row));
    return {
      task: readTask(taskRow),
      runs,
      runtime_state: readRuntimeState(runtimeRow),
      events: this.listEvents(taskId),
    };
  }

  listTaskAggregates(): PersistedTaskAggregate[] {
    return this.database
      .prepare('SELECT task_id FROM tasks ORDER BY updated_at DESC, task_id DESC')
      .all()
      .map((row) => this.getTaskAggregate(readString(row, 'task_id')))
      .filter((aggregate): aggregate is PersistedTaskAggregate => aggregate !== undefined);
  }

  listEvents(taskId: string, afterSequence = 0): PersistedCoordinationEvent[] {
    return this.database
      .prepare('SELECT * FROM events WHERE task_id = ? AND sequence > ? ORDER BY sequence ASC')
      .all(taskId, afterSequence)
      .map((row) => readEvent(row));
  }

  close(): void {
    this.database.close();
  }

  private configure(): void {
    this.database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
    `);
  }

  private migrate(): void {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS tasks (
          task_id TEXT PRIMARY KEY,
          parent_id TEXT,
          status TEXT NOT NULL CHECK (status IN (${sqlList(TASK_STATUSES)})),
          owner_agent_id TEXT,
          role_id TEXT,
          risk_level TEXT NOT NULL CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
          spec TEXT NOT NULL,
          completion_criteria_json TEXT NOT NULL,
          affected_paths_json TEXT NOT NULL,
          budget_json TEXT,
          workspace_path TEXT NOT NULL,
          warnings_json TEXT NOT NULL,
          final_output_json TEXT,
          error_json TEXT,
          revision INTEGER NOT NULL CHECK (revision > 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          schema_version TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS runs (
          run_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
          status TEXT NOT NULL CHECK (status IN (${sqlList(RUN_STATUSES)})),
          mode TEXT NOT NULL CHECK (mode IN (${sqlList(RUN_MODES)})),
          workspace_path TEXT NOT NULL,
          session_id TEXT,
          restarted_from_run_id TEXT REFERENCES runs(run_id),
          snapshot_json TEXT,
          error_json TEXT,
          revision INTEGER NOT NULL CHECK (revision > 0),
          started_at TEXT,
          completed_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          schema_version TEXT NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS one_active_run_per_task
          ON runs(task_id)
          WHERE status IN ('created', 'running');

        CREATE TABLE IF NOT EXISTS task_runtime_states (
          task_id TEXT PRIMARY KEY REFERENCES tasks(task_id) ON DELETE CASCADE,
          current_run_id TEXT REFERENCES runs(run_id) ON DELETE SET NULL,
          resume_cursor TEXT NOT NULL CHECK (resume_cursor IN (${sqlList(RESUME_CURSORS)})),
          waiting_on_json TEXT NOT NULL,
          interrupt_state_json TEXT,
          artifact_refs_json TEXT NOT NULL,
          diagnostics_json TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          schema_version TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT NOT NULL UNIQUE,
          event_type TEXT NOT NULL,
          subject_id TEXT NOT NULL,
          run_id TEXT REFERENCES runs(run_id),
          task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          schema_version TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS events_by_task_sequence ON events(task_id, sequence);
        CREATE INDEX IF NOT EXISTS events_by_run_sequence ON events(run_id, sequence);

        CREATE TABLE IF NOT EXISTS checkpoints (
          checkpoint_id TEXT PRIMARY KEY,
          parent_checkpoint_id TEXT REFERENCES checkpoints(checkpoint_id),
          checkpoint_type TEXT NOT NULL CHECK (checkpoint_type IN ('full', 'incremental')),
          task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
          agent_id TEXT NOT NULL,
          trigger TEXT NOT NULL,
          mechanical_snapshot_json TEXT NOT NULL,
          semantic_handoff_json TEXT NOT NULL,
          runtime_state_json TEXT,
          interrupt_state_json TEXT,
          artifact_refs_json TEXT NOT NULL,
          validity_status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          schema_version TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS messages (
          message_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          from_agent_id TEXT NOT NULL,
          type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          artifact_refs_json TEXT NOT NULL,
          requires_ack INTEGER NOT NULL CHECK (requires_ack IN (0, 1)),
          reply_to_message_id TEXT REFERENCES messages(message_id),
          created_at TEXT NOT NULL,
          schema_version TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS deliveries (
          delivery_id TEXT PRIMARY KEY,
          message_id TEXT NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE,
          recipient_agent_id TEXT,
          recipient_role_id TEXT,
          status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'acknowledged')),
          deadline_at TEXT,
          delivered_at TEXT,
          acknowledged_at TEXT,
          retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
          last_error_json TEXT,
          last_delivery_event_id TEXT REFERENCES events(event_id),
          replay_cursor TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          schema_version TEXT NOT NULL,
          CHECK (recipient_agent_id IS NOT NULL OR recipient_role_id IS NOT NULL)
        );
      `);
      this.database
        .prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)')
        .run(1, new Date().toISOString());
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private writeTask(input: CoordinationStateCommit): void {
    const current = this.database
      .prepare('SELECT revision FROM tasks WHERE task_id = ?')
      .get(input.task.task_id);
    if (!current) {
      if (input.expected_task_revision !== undefined) {
        throw new Error(`Task ${input.task.task_id} does not exist`);
      }
      if (input.task.revision !== 1) {
        throw new Error(`New task ${input.task.task_id} must start at revision 1`);
      }
      taskInsert(this.database).run(...taskValues(input.task));
      return;
    }

    const currentRevision = readNumber(current, 'revision');
    if (input.expected_task_revision !== currentRevision) {
      throw new Error(
        `Task ${input.task.task_id} revision conflict: expected ${String(input.expected_task_revision)}, current ${String(currentRevision)}`,
      );
    }
    if (input.task.revision !== currentRevision + 1) {
      throw new Error(`Task ${input.task.task_id} revision must advance by one`);
    }
    taskUpdate(this.database).run(...taskValues(input.task), input.task.task_id);
  }

  private writeRun(run: PersistedRunState): void {
    const active = isActiveRun(run.status)
      ? this.database
          .prepare(
            "SELECT run_id FROM runs WHERE task_id = ? AND status IN ('created', 'running') AND run_id <> ?",
          )
          .get(run.task_id, run.run_id)
      : undefined;
    if (active) {
      throw new Error(`Task ${run.task_id} already has active run ${readString(active, 'run_id')}`);
    }

    const current = this.database
      .prepare('SELECT task_id, revision FROM runs WHERE run_id = ?')
      .get(run.run_id);
    if (!current) {
      if (run.revision !== 1) throw new Error(`New run ${run.run_id} must start at revision 1`);
      runInsert(this.database).run(...runValues(run));
      return;
    }
    if (readString(current, 'task_id') !== run.task_id) {
      throw new Error(`Run ${run.run_id} cannot change task ownership`);
    }
    if (run.revision !== readNumber(current, 'revision') + 1) {
      throw new Error(`Run ${run.run_id} revision must advance by one`);
    }
    runUpdate(this.database).run(...runValues(run), run.run_id);
  }

  private writeRuntimeState(state: PersistedTaskRuntimeState): void {
    this.database
      .prepare(
        `INSERT INTO task_runtime_states (
          task_id, current_run_id, resume_cursor, waiting_on_json, interrupt_state_json,
          artifact_refs_json, diagnostics_json, updated_at, schema_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET
          current_run_id = excluded.current_run_id,
          resume_cursor = excluded.resume_cursor,
          waiting_on_json = excluded.waiting_on_json,
          interrupt_state_json = excluded.interrupt_state_json,
          artifact_refs_json = excluded.artifact_refs_json,
          diagnostics_json = excluded.diagnostics_json,
          updated_at = excluded.updated_at,
          schema_version = excluded.schema_version`,
      )
      .run(
        state.task_id,
        state.current_run_id ?? null,
        state.resume_cursor,
        toJson(state.waiting_on),
        state.interrupt_state ? toJson(state.interrupt_state) : null,
        toJson(state.artifact_refs),
        toJson(state.diagnostics),
        state.updated_at,
        state.schema_version,
      );
  }

  private writeEvent(event: Event): PersistedCoordinationEvent {
    if (!event.task_id) throw new Error(`Coordination event ${event.event_id} requires task_id`);
    const result = this.database
      .prepare(
        `INSERT INTO events (
          event_id, event_type, subject_id, run_id, task_id, payload_json, created_at, schema_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.event_id,
        event.event_type,
        event.subject_id,
        event.run_id ?? null,
        event.task_id,
        toJson(event.payload),
        event.created_at,
        event.schema_version,
      );
    return { ...event, sequence: Number(result.lastInsertRowid) };
  }
}

function validateCommit(input: CoordinationStateCommit): void {
  if (input.events.length === 0) throw new Error('State commit requires at least one event');
  if (input.runtime_state.task_id !== input.task.task_id) {
    throw new Error('Runtime state belongs to another task');
  }
  if (input.run && input.run.task_id !== input.task.task_id) {
    throw new Error('Run belongs to another task');
  }
  for (const event of input.events) {
    if (event.task_id !== input.task.task_id) throw new Error('Event belongs to another task');
    if (event.run_id && input.run && event.run_id !== input.run.run_id) {
      throw new Error('Event belongs to another run');
    }
  }
  if (input.task.status === 'completed') {
    const finalOutput = input.task.final_output;
    if (
      !finalOutput?.artifact_ref ||
      !finalOutput.workspace_path ||
      !/^[a-f0-9]{64}$/.test(finalOutput.sha256)
    ) {
      throw new Error('Completed task requires verifiable final artifact evidence');
    }
  }
}

function taskInsert(database: DatabaseSync): StatementSync {
  return database.prepare(
    `INSERT INTO tasks (
      task_id, parent_id, status, owner_agent_id, role_id, risk_level, spec,
      completion_criteria_json, affected_paths_json, budget_json, workspace_path,
      warnings_json, final_output_json, error_json, revision, created_at, updated_at, schema_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
}

function taskUpdate(database: DatabaseSync): StatementSync {
  return database.prepare(
    `UPDATE tasks SET
      task_id = ?, parent_id = ?, status = ?, owner_agent_id = ?, role_id = ?, risk_level = ?,
      spec = ?, completion_criteria_json = ?, affected_paths_json = ?, budget_json = ?,
      workspace_path = ?, warnings_json = ?, final_output_json = ?, error_json = ?, revision = ?,
      created_at = ?, updated_at = ?, schema_version = ?
    WHERE task_id = ?`,
  );
}

function taskValues(task: PersistedTaskState): SQLInputValue[] {
  return [
    task.task_id,
    task.parent_id ?? null,
    task.status,
    task.owner_agent_id ?? null,
    task.role_id ?? null,
    task.risk_level,
    task.spec,
    toJson(task.completion_criteria),
    toJson(task.affected_paths),
    task.budget ? toJson(task.budget) : null,
    task.workspace_path,
    toJson(task.warnings),
    task.final_output ? toJson(task.final_output) : null,
    task.error ? toJson(task.error) : null,
    task.revision,
    task.created_at,
    task.updated_at,
    task.schema_version,
  ];
}

function runInsert(database: DatabaseSync): StatementSync {
  return database.prepare(
    `INSERT INTO runs (
      run_id, task_id, status, mode, workspace_path, session_id, restarted_from_run_id,
      snapshot_json, error_json, revision, started_at, completed_at, created_at, updated_at,
      schema_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
}

function runUpdate(database: DatabaseSync): StatementSync {
  return database.prepare(
    `UPDATE runs SET
      run_id = ?, task_id = ?, status = ?, mode = ?, workspace_path = ?, session_id = ?,
      restarted_from_run_id = ?, snapshot_json = ?, error_json = ?, revision = ?, started_at = ?,
      completed_at = ?, created_at = ?, updated_at = ?, schema_version = ?
    WHERE run_id = ?`,
  );
}

function runValues(run: PersistedRunState): SQLInputValue[] {
  return [
    run.run_id,
    run.task_id,
    run.status,
    run.mode,
    run.workspace_path,
    run.session_id ?? null,
    run.restarted_from_run_id ?? null,
    run.snapshot ? toJson(run.snapshot) : null,
    run.error ? toJson(run.error) : null,
    run.revision,
    run.started_at ?? null,
    run.completed_at ?? null,
    run.created_at,
    run.updated_at,
    run.schema_version,
  ];
}

function readTask(row: SqlRow): PersistedTaskState {
  const budget = readOptionalJson<Record<string, number>>(row, 'budget_json');
  const finalOutput = readOptionalJson<PersistedTaskState['final_output']>(
    row,
    'final_output_json',
  );
  const error = readOptionalJson<PersistedTaskState['error']>(row, 'error_json');
  return {
    task_id: readString(row, 'task_id'),
    ...(readOptionalString(row, 'parent_id') ? { parent_id: readString(row, 'parent_id') } : {}),
    status: readEnum(row, 'status', TASK_STATUSES),
    ...(readOptionalString(row, 'owner_agent_id')
      ? { owner_agent_id: readString(row, 'owner_agent_id') }
      : {}),
    ...(readOptionalString(row, 'role_id') ? { role_id: readString(row, 'role_id') } : {}),
    risk_level: readEnum(row, 'risk_level', ['low', 'medium', 'high', 'critical'] as const),
    spec: readString(row, 'spec'),
    completion_criteria: readJson<string[]>(row, 'completion_criteria_json'),
    affected_paths: readJson<string[]>(row, 'affected_paths_json'),
    ...(budget ? { budget } : {}),
    workspace_path: readString(row, 'workspace_path'),
    warnings: readJson<string[]>(row, 'warnings_json'),
    ...(finalOutput ? { final_output: finalOutput } : {}),
    ...(error ? { error } : {}),
    revision: readNumber(row, 'revision'),
    created_at: readString(row, 'created_at'),
    updated_at: readString(row, 'updated_at'),
    schema_version: readSchemaVersion(row),
  };
}

function readRun(row: SqlRow): PersistedRunState {
  const snapshot = readOptionalJson<PersistedRunState['snapshot']>(row, 'snapshot_json');
  const error = readOptionalJson<PersistedRunState['error']>(row, 'error_json');
  return {
    run_id: readString(row, 'run_id'),
    task_id: readString(row, 'task_id'),
    status: readEnum(row, 'status', RUN_STATUSES),
    mode: readEnum(row, 'mode', RUN_MODES),
    workspace_path: readString(row, 'workspace_path'),
    ...(readOptionalString(row, 'session_id') ? { session_id: readString(row, 'session_id') } : {}),
    ...(readOptionalString(row, 'restarted_from_run_id')
      ? { restarted_from_run_id: readString(row, 'restarted_from_run_id') }
      : {}),
    ...(snapshot ? { snapshot } : {}),
    ...(error ? { error } : {}),
    revision: readNumber(row, 'revision'),
    ...(readOptionalString(row, 'started_at') ? { started_at: readString(row, 'started_at') } : {}),
    ...(readOptionalString(row, 'completed_at')
      ? { completed_at: readString(row, 'completed_at') }
      : {}),
    created_at: readString(row, 'created_at'),
    updated_at: readString(row, 'updated_at'),
    schema_version: readSchemaVersion(row),
  };
}

function readRuntimeState(row: SqlRow): PersistedTaskRuntimeState {
  const interruptState = readOptionalJson<Record<string, unknown>>(row, 'interrupt_state_json');
  return {
    task_id: readString(row, 'task_id'),
    ...(readOptionalString(row, 'current_run_id')
      ? { current_run_id: readString(row, 'current_run_id') }
      : {}),
    resume_cursor: readEnum(row, 'resume_cursor', RESUME_CURSORS) as TaskResumeCursor,
    waiting_on: readJson<Record<string, unknown>[]>(row, 'waiting_on_json'),
    ...(interruptState ? { interrupt_state: interruptState } : {}),
    artifact_refs: readJson<string[]>(row, 'artifact_refs_json'),
    diagnostics: readJson<Record<string, unknown>>(row, 'diagnostics_json'),
    updated_at: readString(row, 'updated_at'),
    schema_version: readSchemaVersion(row),
  };
}

function readEvent(row: SqlRow): PersistedCoordinationEvent {
  const runId = readOptionalString(row, 'run_id');
  return {
    sequence: readNumber(row, 'sequence'),
    event_id: readString(row, 'event_id'),
    event_type: readString(row, 'event_type'),
    subject_id: readString(row, 'subject_id'),
    ...(runId ? { run_id: runId } : {}),
    task_id: readString(row, 'task_id'),
    payload: readJson<Record<string, unknown>>(row, 'payload_json'),
    created_at: readString(row, 'created_at'),
    schema_version: readSchemaVersion(row),
  };
}

function readString(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new Error(`Expected ${key} to be a string`);
  return value;
}

function readOptionalString(row: SqlRow, key: string): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`Expected ${key} to be a string or null`);
  return value;
}

function readNumber(row: SqlRow, key: string): number {
  const value = row[key];
  if (typeof value !== 'number') throw new Error(`Expected ${key} to be a number`);
  return value;
}

function readSchemaVersion(row: SqlRow): typeof SCHEMA_VERSION {
  const value = readString(row, 'schema_version');
  if (value !== SCHEMA_VERSION) throw new Error(`Unsupported schema_version: ${value}`);
  return value;
}

function readJson<T>(row: SqlRow, key: string): T {
  return JSON.parse(readString(row, key)) as T;
}

function readOptionalJson<T>(row: SqlRow, key: string): T | undefined {
  const value = readOptionalString(row, key);
  return value === undefined ? undefined : (JSON.parse(value) as T);
}

function readEnum<const T extends readonly string[]>(
  row: SqlRow,
  key: string,
  values: T,
): T[number] {
  const value = readString(row, key);
  if (!values.includes(value)) throw new Error(`Invalid ${key}: ${value}`);
  return value as T[number];
}

function toJson(value: unknown): string {
  return JSON.stringify(value);
}

function sqlList(values: readonly string[]): string {
  return values.map((value) => `'${value.replaceAll("'", "''")}'`).join(', ');
}

function isActiveRun(status: PersistedRunState['status']): boolean {
  return status === 'created' || status === 'running';
}

export type { CoordinationStateCommit } from './coordination-state-store';
