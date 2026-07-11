/**
 * RPC 进程内运行注册表。
 *
 * 这个文件负责 run 查询、事件顺序和订阅，不启动 Coordinator，也不做跨进程持久化。
 */
import type { FrontendRunSnapshot } from '../coordinator/frontend-run-snapshot';

export type AppRunMode = 'single_agent' | 'council';
export type AppRunStatus = 'running' | 'completed' | 'failed';
export type AppRunStage = 'executing' | 'council' | 'delivery' | 'intervention';

export interface AppRunEvent {
  sequence: number;
  run_id: string;
  type: string;
  created_at: string;
  payload: Record<string, unknown>;
}

export interface AppRunSnapshot {
  schema_version: 'v0';
  revision: number;
  run_id: string;
  task_id: string;
  status: AppRunStatus;
  mode: AppRunMode;
  current: {
    stage: AppRunStage;
    active_node_code: string;
  };
  events: AppRunEvent[];
  snapshot?: FrontendRunSnapshot;
  error?: { code: string; message: string };
}

export class RunNotFoundError extends Error {
  constructor(readonly runId: string) {
    super(`Run ${runId} was not found`);
    this.name = 'RunNotFoundError';
  }
}

type RunEventListener = (event: AppRunEvent) => void;

interface MutableRunRecord extends AppRunSnapshot {
  listeners: Set<RunEventListener>;
}

const EVENT_NODE_CODES: Readonly<Record<string, string>> = {
  'task.created': 'N2',
  'run.started': 'N3',
  'memory.context_pack_built': 'N5',
  'driver.run_result': 'N8',
  'artifact.registered': 'N9',
  'task.completed': 'N10',
  'gate.result': 'N13',
  'council.started': 'N14',
  'council.decision': 'N14',
  'checkpoint.saved': 'N16',
  'run.completed': 'N18',
  'run.failed': 'N18',
};

export class InMemoryRunRegistry {
  private readonly records = new Map<string, MutableRunRecord>();

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  create(input: { run_id: string; task_id: string; mode: AppRunMode }): AppRunSnapshot {
    const record: MutableRunRecord = {
      schema_version: 'v0',
      revision: 0,
      ...input,
      status: 'running',
      current: {
        stage: input.mode === 'council' ? 'council' : 'executing',
        active_node_code: 'N3',
      },
      events: [],
      listeners: new Set(),
    };
    this.records.set(input.run_id, record);
    return this.clone(record);
  }

  appendEvent(runId: string, type: string, payload: Record<string, unknown>): AppRunEvent {
    const record = this.require(runId);
    const event: AppRunEvent = {
      sequence: record.events.length + 1,
      run_id: runId,
      type,
      created_at: this.now(),
      payload,
    };
    record.events.push(event);
    record.revision += 1;
    record.current.active_node_code = EVENT_NODE_CODES[type] ?? record.current.active_node_code;
    for (const listener of record.listeners) listener(event);
    return event;
  }

  complete(runId: string, snapshot: FrontendRunSnapshot): AppRunSnapshot {
    const record = this.require(runId);
    record.status = 'completed';
    record.current = { stage: 'delivery', active_node_code: 'N18' };
    record.snapshot = snapshot;
    this.appendEvent(runId, 'run.completed', { status: 'completed' });
    return this.clone(record);
  }

  fail(runId: string, code: string, message: string): AppRunSnapshot {
    const record = this.require(runId);
    record.status = 'failed';
    record.current = { stage: 'intervention', active_node_code: 'N18' };
    record.error = { code, message };
    this.appendEvent(runId, 'run.failed', { code });
    return this.clone(record);
  }

  getSnapshot(runId: string): AppRunSnapshot {
    return this.clone(this.require(runId));
  }

  subscribe(runId: string, listener: RunEventListener): () => void {
    const record = this.require(runId);
    record.listeners.add(listener);
    return () => record.listeners.delete(listener);
  }

  private require(runId: string): MutableRunRecord {
    const record = this.records.get(runId);
    if (!record) throw new RunNotFoundError(runId);
    return record;
  }

  private clone(record: MutableRunRecord): AppRunSnapshot {
    const { listeners: _listeners, ...snapshot } = record;
    return { ...snapshot, current: { ...snapshot.current }, events: [...snapshot.events] };
  }
}
