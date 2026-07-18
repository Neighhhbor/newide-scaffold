import {
  SCHEMA_VERSION,
  createId,
  type Event,
  type EventType,
  type TaskCreateRequest,
} from '../core';
import { assertTaskStatusTransition } from '../coordinator/task-state-machine';
import {
  type CoordinationStateStore,
  type PersistedRunMode,
  type PersistedRunState,
  type PersistedTaskAggregate,
  type PersistedTaskFinalOutput,
  type PersistedFullCheckpoint,
  type PersistedTaskState,
  type TaskResumeCursor,
} from '../persistence';
import type { RunSnapshot } from '../protocol/run-snapshot';
import { projectRunEventSource } from '../protocol/run-event';
import { taskSnapshotSchema, type TaskSnapshot } from '../protocol/task-snapshot';
import type { AppRunEvent } from './run-registry';
import { projectTaskSnapshot, type TaskRunFact } from './task-snapshot-projector';

export interface TaskProcessorOptions {
  now?: () => string;
  createEventId?: () => string;
}

export interface BeginTaskRunInput {
  task_id: string;
  run_id: string;
  task_request: TaskCreateRequest;
  workspace_path: string;
  mode: PersistedRunMode;
  session_id?: string;
  restarted_from_run_id?: string;
  resume_checkpoint_id?: string;
  requested_resume_cursor?: TaskResumeCursor;
  task_created_event?: Event;
  run_created_event?: Event;
  run_started_event?: Event;
}

export interface FinishTaskRunInput {
  run_id: string;
  status: 'completed' | 'failed' | 'cancelled';
  snapshot?: RunSnapshot;
  final_output?: PersistedTaskFinalOutput;
  warnings?: string[];
  error?: { code: string; message: string; details?: Record<string, unknown> };
  event?: Event;
}

export interface TaskLaunchContext {
  task_request: TaskCreateRequest;
  workspace_path: string;
  session_id?: string;
}

export interface TaskResumeContext extends TaskLaunchContext {
  checkpoint_id: string;
  resume_cursor: TaskResumeCursor;
  mode: PersistedRunMode;
  interrupted_run_id: string;
}

export class TaskProcessorTaskNotFoundError extends Error {
  constructor(readonly taskId: string) {
    super(`Task ${taskId} was not found in the coordination store`);
    this.name = 'TaskProcessorTaskNotFoundError';
  }
}

export class TaskProcessorRunNotFoundError extends Error {
  constructor(readonly runId: string) {
    super(`Run ${runId} was not found in the coordination store`);
    this.name = 'TaskProcessorRunNotFoundError';
  }
}

export class TaskEventCursorNotFoundError extends Error {
  constructor(
    readonly taskId: string,
    readonly eventId: string,
  ) {
    super(`Task ${taskId} event cursor ${eventId} was not found`);
    this.name = 'TaskEventCursorNotFoundError';
  }
}

export class TaskProcessor {
  private readonly now: () => string;
  private readonly createEventId: () => string;

  constructor(
    private readonly store: CoordinationStateStore,
    options: TaskProcessorOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.createEventId = options.createEventId ?? (() => createId('event'));
  }

  beginRun(input: BeginTaskRunInput): TaskSnapshot {
    const existing = this.store.getTaskAggregate(input.task_id);
    const activeRun = existing?.runs.find((run) => isActiveRun(run));
    if (activeRun) {
      throw new Error(`Task ${input.task_id} already has active run ${activeRun.run_id}`);
    }
    if (existing) {
      assertImmutableTaskDefinition(existing.task, input.task_request, input.workspace_path);
    }

    const timestamp = this.now();
    const task: PersistedTaskState = existing
      ? (() => {
          const {
            final_output: _previousFinalOutput,
            error: _previousError,
            ...previousTask
          } = existing.task;
          return {
            ...previousTask,
            status: 'running',
            warnings: [],
            revision: existing.task.revision + 1,
            updated_at: timestamp,
          };
        })()
      : {
          task_id: input.task_id,
          ...(input.task_request.parent_task_id
            ? { parent_id: input.task_request.parent_task_id }
            : {}),
          status: 'running',
          ...(input.task_request.role_id ? { role_id: input.task_request.role_id } : {}),
          risk_level: input.task_request.risk_level ?? 'low',
          spec: input.task_request.spec,
          completion_criteria: [...input.task_request.completion_criteria],
          affected_paths: [...(input.task_request.affected_paths ?? [])],
          ...(input.task_request.budget ? { budget: { ...input.task_request.budget } } : {}),
          workspace_path: input.workspace_path,
          warnings: [],
          revision: 1,
          created_at: timestamp,
          updated_at: timestamp,
          schema_version: SCHEMA_VERSION,
        };
    const run: PersistedRunState = {
      run_id: input.run_id,
      task_id: input.task_id,
      status: 'running',
      mode: input.mode,
      workspace_path: input.workspace_path,
      ...(input.session_id ? { session_id: input.session_id } : {}),
      ...(input.restarted_from_run_id
        ? { restarted_from_run_id: input.restarted_from_run_id }
        : {}),
      revision: 1,
      started_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
      schema_version: SCHEMA_VERSION,
    };
    const events = [
      ...(existing
        ? []
        : [
            input.task_created_event ??
              this.createEvent('task.created', input.task_id, input.task_id, input.run_id, {
                spec: input.task_request.spec,
                risk_level: input.task_request.risk_level ?? 'low',
              }),
          ]),
      input.run_created_event ??
        this.createEvent('run.created', input.run_id, input.task_id, input.run_id, {
          mode: input.mode,
        }),
      input.run_started_event ??
        this.createEvent('run.started', input.run_id, input.task_id, input.run_id, {
          mode: input.mode,
        }),
    ];

    this.store.commitState({
      ...(existing ? { expected_task_revision: existing.task.revision } : {}),
      task,
      run,
      runtime_state: {
        task_id: input.task_id,
        current_run_id: input.run_id,
        resume_cursor: input.mode === 'single_agent' ? 'select_agent' : 'execute_agent',
        waiting_on: [],
        artifact_refs: [],
        diagnostics: {
          mode: input.mode,
          ...(input.resume_checkpoint_id
            ? { resume_checkpoint_id: input.resume_checkpoint_id }
            : {}),
          ...(input.requested_resume_cursor
            ? { requested_resume_cursor: input.requested_resume_cursor }
            : {}),
        },
        updated_at: timestamp,
        schema_version: SCHEMA_VERSION,
      },
      events,
    });
    return this.getTaskSnapshot(input.task_id);
  }

  recordRunEvent(runId: string, event: Event): TaskSnapshot {
    const aggregate = this.requireAggregateForRun(runId);
    if (aggregate.events.some((candidate) => candidate.event_id === event.event_id)) {
      return projectAggregate(aggregate);
    }
    const run = requireRun(aggregate, runId);
    if (!isActiveRun(run)) throw new Error(`Run ${runId} is already ${run.status}`);
    if (event.task_id !== aggregate.task.task_id || event.run_id !== runId) {
      throw new Error(`Event ${event.event_id} does not belong to run ${runId}`);
    }

    const timestamp = event.created_at || this.now();
    const selectedAgent = readPayloadString(event.payload, 'winner_agent_id');
    const sessionId = run.session_id ?? readPayloadString(event.payload, 'session_id');
    const artifactRefs = appendUnique(
      aggregate.runtime_state.artifact_refs,
      readPayloadStringArray(event.payload, 'artifact_refs'),
    );
    this.store.commitState({
      expected_task_revision: aggregate.task.revision,
      task: {
        ...aggregate.task,
        ...(selectedAgent ? { owner_agent_id: selectedAgent } : {}),
        revision: aggregate.task.revision + 1,
        updated_at: timestamp,
      },
      run: {
        ...run,
        ...(sessionId ? { session_id: sessionId } : {}),
        revision: run.revision + 1,
        updated_at: timestamp,
      },
      runtime_state: {
        ...aggregate.runtime_state,
        resume_cursor: cursorAfterEvent(
          event.event_type,
          event.payload,
          run.mode,
          aggregate.runtime_state.resume_cursor,
        ),
        artifact_refs: artifactRefs,
        diagnostics: {
          ...aggregate.runtime_state.diagnostics,
          last_event_id: event.event_id,
          last_event_type: event.event_type,
        },
        updated_at: timestamp,
      },
      events: [event],
    });
    return this.getTaskSnapshot(aggregate.task.task_id);
  }

  recoverInterruptedTasks(): TaskSnapshot[] {
    return this.store
      .listTaskAggregates()
      .filter((aggregate) => aggregate.runs.some((run) => isActiveRun(run)))
      .map((aggregate) => this.recoverInterruptedTask(aggregate));
  }

  finishRun(input: FinishTaskRunInput): TaskSnapshot {
    const aggregate = this.requireAggregateForRun(input.run_id);
    const run = requireRun(aggregate, input.run_id);
    if (!isActiveRun(run)) {
      if (run.status === input.status) return projectAggregate(aggregate);
      throw new Error(`Run ${input.run_id} already reached ${run.status}`);
    }
    assertTaskStatusTransition(aggregate.task.status, input.status);

    const timestamp = input.event?.created_at ?? this.now();
    const warnings = input.warnings ?? councilWarnings(input.snapshot);
    const error = input.error ?? firstSnapshotError(input.snapshot);
    const terminalEvent =
      input.event ??
      this.createEvent(
        input.status === 'completed'
          ? 'run.completed'
          : input.status === 'failed'
            ? 'run.failed'
            : 'run.cancelled',
        input.run_id,
        aggregate.task.task_id,
        input.run_id,
        {
          status: input.status,
          ...(error ? { code: error.code, message: error.message } : {}),
        },
      );
    const snapshotSessionId =
      input.snapshot?.run?.session_id ?? input.snapshot?.final_output?.session_id;
    const artifactRefs = appendUnique(
      aggregate.runtime_state.artifact_refs,
      input.snapshot?.final_output?.artifact_refs ?? [],
    );

    const {
      final_output: _previousFinalOutput,
      error: _previousTaskError,
      ...taskWithoutTerminalOutput
    } = aggregate.task;
    const { error: _previousRunError, ...runWithoutError } = run;
    const { current_run_id: _currentRunId, ...runtimeWithoutCurrentRun } = aggregate.runtime_state;

    this.store.commitState({
      expected_task_revision: aggregate.task.revision,
      task: {
        ...taskWithoutTerminalOutput,
        status: input.status,
        warnings: [...warnings],
        ...(input.status === 'completed' && input.final_output
          ? { final_output: { ...input.final_output } }
          : {}),
        ...(error ? { error: { ...error } } : {}),
        revision: aggregate.task.revision + 1,
        updated_at: timestamp,
      },
      run: {
        ...runWithoutError,
        status: input.status,
        ...(snapshotSessionId ? { session_id: snapshotSessionId } : {}),
        ...(input.snapshot ? { snapshot: input.snapshot } : {}),
        ...(error ? { error: { ...error } } : {}),
        revision: run.revision + 1,
        completed_at: timestamp,
        updated_at: timestamp,
      },
      runtime_state: {
        ...runtimeWithoutCurrentRun,
        resume_cursor: 'done',
        waiting_on: [],
        artifact_refs: artifactRefs,
        diagnostics: {
          ...aggregate.runtime_state.diagnostics,
          terminal_status: input.status,
          terminal_event_id: terminalEvent.event_id,
        },
        updated_at: timestamp,
      },
      events: [terminalEvent],
    });
    return this.getTaskSnapshot(aggregate.task.task_id);
  }

  getTaskSnapshot(taskId: string): TaskSnapshot {
    const aggregate = this.store.getTaskAggregate(taskId);
    if (!aggregate) throw new TaskProcessorTaskNotFoundError(taskId);
    return projectAggregate(aggregate);
  }

  listTaskSnapshots(): TaskSnapshot[] {
    return this.store.listTaskAggregates().map(projectAggregate);
  }

  listTaskEvents(taskId: string, afterEventId?: string): AppRunEvent[] {
    if (!afterEventId) return [];
    const aggregate = this.store.getTaskAggregate(taskId);
    if (!aggregate) throw new TaskProcessorTaskNotFoundError(taskId);
    const cursorIndex = aggregate.events.findIndex((event) => event.event_id === afterEventId);
    if (cursorIndex < 0) throw new TaskEventCursorNotFoundError(taskId, afterEventId);
    return aggregate.events.slice(cursorIndex + 1).map((event) => ({
      event_id: event.event_id,
      sequence: event.sequence,
      run_id: event.run_id ?? event.subject_id,
      task_id: event.task_id ?? taskId,
      type: event.event_type,
      source: projectRunEventSource(event.event_type),
      created_at: event.created_at,
      payload: { ...event.payload },
      schema_version: event.schema_version,
    }));
  }

  getRunSnapshot(runId: string): RunSnapshot | undefined {
    const aggregate = this.store
      .listTaskAggregates()
      .find((candidate) => candidate.runs.some((run) => run.run_id === runId));
    return aggregate?.runs.find((run) => run.run_id === runId)?.snapshot;
  }

  getTaskLaunchContext(taskId: string): TaskLaunchContext {
    const aggregate = this.store.getTaskAggregate(taskId);
    if (!aggregate) throw new TaskProcessorTaskNotFoundError(taskId);
    const latestSession = aggregate.runs.find((run) => run.session_id)?.session_id;
    return {
      task_request: {
        spec: aggregate.task.spec,
        ...(aggregate.task.role_id ? { role_id: aggregate.task.role_id } : {}),
        ...(aggregate.task.parent_id ? { parent_task_id: aggregate.task.parent_id } : {}),
        risk_level: aggregate.task.risk_level,
        affected_paths: [...aggregate.task.affected_paths],
        completion_criteria: [...aggregate.task.completion_criteria],
        ...(aggregate.task.budget ? { budget: { ...aggregate.task.budget } } : {}),
      },
      workspace_path: aggregate.task.workspace_path,
      ...(latestSession ? { session_id: latestSession } : {}),
    };
  }

  getTaskResumeContext(taskId: string): TaskResumeContext {
    const aggregate = this.store.getTaskAggregate(taskId);
    if (!aggregate) throw new TaskProcessorTaskNotFoundError(taskId);
    const checkpoint = this.store.getLatestCheckpoint(taskId);
    if (!checkpoint) throw new Error(`Task ${taskId} has no valid full checkpoint`);
    const interruptedRun = requireRun(aggregate, checkpoint.run_id);
    const launch = this.getTaskLaunchContext(taskId);
    const sessionId = checkpoint.session_id ?? interruptedRun.session_id ?? launch.session_id;
    return {
      ...launch,
      ...(sessionId ? { session_id: sessionId } : {}),
      checkpoint_id: checkpoint.checkpoint_id,
      resume_cursor: checkpoint.resume_cursor,
      mode: interruptedRun.mode,
      interrupted_run_id: interruptedRun.run_id,
    };
  }

  private requireAggregateForRun(runId: string): PersistedTaskAggregate {
    const aggregate = this.store
      .listTaskAggregates()
      .find((candidate) => candidate.runs.some((run) => run.run_id === runId));
    if (!aggregate) throw new TaskProcessorRunNotFoundError(runId);
    return aggregate;
  }

  private recoverInterruptedTask(aggregate: PersistedTaskAggregate): TaskSnapshot {
    const run = aggregate.runs.find((candidate) => isActiveRun(candidate));
    if (!run) return projectAggregate(aggregate);
    assertTaskStatusTransition(aggregate.task.status, 'blocked');

    const timestamp = this.now();
    const reason = 'The backend process ended before the active run reached a terminal state.';
    const interruptState = {
      type: 'process_interrupted',
      reason,
      interrupted_run_id: run.run_id,
    };
    const checkpointId = createId('checkpoint');
    const latestCheckpoint = this.store.getLatestCheckpoint(aggregate.task.task_id);
    const checkpoint: PersistedFullCheckpoint = {
      checkpoint_id: checkpointId,
      ...(latestCheckpoint ? { parent_checkpoint_id: latestCheckpoint.checkpoint_id } : {}),
      task_id: aggregate.task.task_id,
      run_id: run.run_id,
      agent_id:
        readLatestEventString(aggregate, 'agent_id') ??
        aggregate.task.owner_agent_id ??
        aggregate.task.role_id ??
        'coordinator',
      ...(run.session_id ? { session_id: run.session_id } : {}),
      trigger: 'blocked',
      resume_cursor: aggregate.runtime_state.resume_cursor,
      message_thread: aggregate.events.map((event, index) => ({
        message_id: event.event_id,
        role: projectRunEventSource(event.event_type),
        content: event.event_type,
        turn: index + 1,
        artifact_refs: readPayloadStringArray(event.payload, 'artifact_refs'),
        created_at: event.created_at,
      })),
      mechanical_snapshot: {
        base_commit: 'unknown',
        worktree_path: aggregate.task.workspace_path,
        branch: 'runtime-recovery',
        modified_files: [],
      },
      semantic_handoff: {
        done: aggregate.events.map((event) => event.event_type),
        in_progress: [aggregate.runtime_state.resume_cursor],
        blocked_on: ['backend process interrupted'],
        assumptions: [],
        next_steps: [`resume ${aggregate.runtime_state.resume_cursor}`],
        known_risks: ['unfinished action will be re-executed'],
      },
      interrupt_state: interruptState,
      artifact_refs: [...aggregate.runtime_state.artifact_refs],
      validity_status: 'valid',
      created_at: timestamp,
      schema_version: SCHEMA_VERSION,
    };
    const runInterrupted = this.createEvent(
      'run.interrupted',
      run.run_id,
      aggregate.task.task_id,
      run.run_id,
      { reason, resume_cursor: aggregate.runtime_state.resume_cursor },
    );
    const taskBlocked = this.createEvent(
      'task.blocked',
      aggregate.task.task_id,
      aggregate.task.task_id,
      run.run_id,
      { reason, interrupted_run_id: run.run_id },
    );
    const checkpointSaved = this.createEvent(
      'checkpoint.saved',
      checkpointId,
      aggregate.task.task_id,
      run.run_id,
      { checkpoint_id: checkpointId, resume_cursor: aggregate.runtime_state.resume_cursor },
    );
    const { current_run_id: _currentRunId, ...runtimeWithoutCurrentRun } = aggregate.runtime_state;

    this.store.commitState({
      expected_task_revision: aggregate.task.revision,
      task: {
        ...aggregate.task,
        status: 'blocked',
        revision: aggregate.task.revision + 1,
        updated_at: timestamp,
      },
      run: {
        ...run,
        status: 'interrupted',
        revision: run.revision + 1,
        completed_at: timestamp,
        updated_at: timestamp,
      },
      runtime_state: {
        ...runtimeWithoutCurrentRun,
        interrupt_state: interruptState,
        diagnostics: {
          ...aggregate.runtime_state.diagnostics,
          interrupted_run_id: run.run_id,
          recovery_checkpoint_id: checkpointId,
        },
        updated_at: timestamp,
      },
      checkpoint,
      events: [runInterrupted, taskBlocked, checkpointSaved],
    });
    return this.getTaskSnapshot(aggregate.task.task_id);
  }

  private createEvent(
    eventType: EventType,
    subjectId: string,
    taskId: string,
    runId: string,
    payload: Record<string, unknown>,
  ): Event {
    return {
      event_id: this.createEventId(),
      event_type: eventType,
      subject_id: subjectId,
      run_id: runId,
      task_id: taskId,
      payload,
      created_at: this.now(),
      schema_version: SCHEMA_VERSION,
    };
  }
}

function projectAggregate(aggregate: PersistedTaskAggregate): TaskSnapshot {
  const projected = projectTaskSnapshot({
    task_id: aggregate.task.task_id,
    task_request: {
      spec: aggregate.task.spec,
      ...(aggregate.task.role_id ? { role_id: aggregate.task.role_id } : {}),
      ...(aggregate.task.parent_id ? { parent_task_id: aggregate.task.parent_id } : {}),
      risk_level: aggregate.task.risk_level,
      affected_paths: [...aggregate.task.affected_paths],
      completion_criteria: [...aggregate.task.completion_criteria],
      ...(aggregate.task.budget ? { budget: { ...aggregate.task.budget } } : {}),
    },
    created_at: aggregate.task.created_at,
    runs: aggregate.runs.map(toRunFact),
  });
  const waitingReason = readWaitingReason(aggregate);
  return taskSnapshotSchema.parse({
    ...projected,
    revision: aggregate.task.revision,
    task: {
      ...projected.task,
      status: aggregate.task.status,
      ...(aggregate.task.owner_agent_id ? { owner_agent_id: aggregate.task.owner_agent_id } : {}),
      updated_at: aggregate.task.updated_at,
    },
    ...(waitingReason ? { waiting_reason: waitingReason } : {}),
    warnings: [...aggregate.task.warnings],
    ...(aggregate.task.error ? { error: { ...aggregate.task.error } } : {}),
    ...(!projected.final_output && aggregate.task.final_output
      ? {
          final_output: {
            artifact_refs: [aggregate.task.final_output.artifact_ref],
            files_written: [aggregate.task.final_output.workspace_path],
            changed_files: [],
            sha256: aggregate.task.final_output.sha256,
          },
        }
      : {}),
  });
}

function toRunFact(run: PersistedRunState): TaskRunFact {
  return {
    run_id: run.run_id,
    task_id: run.task_id,
    status: run.status === 'created' ? 'running' : run.status,
    mode: run.mode,
    restartable: run.status !== 'running' && run.status !== 'created',
    ...(run.session_id ? { session_id: run.session_id } : {}),
    ...(run.started_at ? { started_at: run.started_at } : {}),
    ...(run.completed_at ? { completed_at: run.completed_at } : {}),
    ...(run.error ? { error: { ...run.error } } : {}),
    revision: run.revision,
    ...(run.snapshot ? { snapshot: run.snapshot } : {}),
  };
}

function requireRun(aggregate: PersistedTaskAggregate, runId: string): PersistedRunState {
  const run = aggregate.runs.find((candidate) => candidate.run_id === runId);
  if (!run) throw new TaskProcessorRunNotFoundError(runId);
  return run;
}

function assertImmutableTaskDefinition(
  task: PersistedTaskState,
  request: TaskCreateRequest,
  workspacePath: string,
): void {
  if (
    task.spec !== request.spec ||
    task.workspace_path !== workspacePath ||
    task.parent_id !== request.parent_task_id ||
    task.role_id !== request.role_id ||
    task.risk_level !== (request.risk_level ?? 'low') ||
    JSON.stringify(task.completion_criteria) !== JSON.stringify(request.completion_criteria) ||
    JSON.stringify(task.affected_paths) !== JSON.stringify(request.affected_paths ?? []) ||
    JSON.stringify(task.budget) !== JSON.stringify(request.budget)
  ) {
    throw new Error(`Task ${task.task_id} definition cannot change between runs`);
  }
}

function isActiveRun(run: PersistedRunState): boolean {
  return run.status === 'created' || run.status === 'running';
}

function cursorAfterEvent(
  eventType: string,
  payload: Record<string, unknown>,
  mode: PersistedRunMode,
  current: TaskResumeCursor,
): TaskResumeCursor {
  if (eventType === 'market.selected') return 'execute_agent';
  if (
    eventType === 'agent.execution_requested' ||
    eventType === 'memory.context_pack_built' ||
    eventType === 'driver.session_started'
  ) {
    return 'execute_agent';
  }
  if (eventType === 'agent.execution_completed' || eventType === 'driver.run_result') {
    return 'gate';
  }
  if (
    eventType.startsWith('council.') &&
    !['council.completed', 'council.decision'].includes(eventType)
  ) {
    return 'council';
  }
  if (eventType === 'council.completed' || eventType === 'council.decision') return 'gate';
  if (eventType === 'gate.result') {
    return mode === 'council' && payload.phase === 'pre_council' ? 'council' : 'deliver';
  }
  if (
    eventType === 'artifact.selected' ||
    eventType === 'artifact.delivered' ||
    eventType === 'worktree.materialized' ||
    eventType === 'checkpoint.saved'
  ) {
    return 'deliver';
  }
  return current;
}

function readPayloadString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readPayloadStringArray(payload: Record<string, unknown>, key: string): string[] {
  const value = payload[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function appendUnique(current: readonly string[], additions: readonly string[]): string[] {
  return [...new Set([...current, ...additions])];
}

function readLatestEventString(
  aggregate: PersistedTaskAggregate,
  key: string,
): string | undefined {
  for (let index = aggregate.events.length - 1; index >= 0; index -= 1) {
    const event = aggregate.events[index];
    if (!event) continue;
    const value = readPayloadString(event.payload, key);
    if (value) return value;
  }
  return undefined;
}

function councilWarnings(snapshot: RunSnapshot | undefined): string[] {
  const result = snapshot?.council?.result;
  if (!result || typeof result !== 'object') return [];
  const warnings = Reflect.get(result, 'warnings');
  return Array.isArray(warnings)
    ? warnings.filter((warning): warning is string => typeof warning === 'string')
    : [];
}

function firstSnapshotError(
  snapshot: RunSnapshot | undefined,
): FinishTaskRunInput['error'] | undefined {
  const error = snapshot?.errors[0];
  return error
    ? {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: { ...error.details } } : {}),
      }
    : undefined;
}

function readWaitingReason(aggregate: PersistedTaskAggregate): string | undefined {
  if (
    !['waiting_help', 'waiting_input', 'pending_gate', 'pending_council', 'blocked'].includes(
      aggregate.task.status,
    )
  ) {
    return undefined;
  }
  const reason = aggregate.runtime_state.interrupt_state?.reason;
  return typeof reason === 'string' && reason.length > 0
    ? reason
    : 'Task is waiting for a persisted runtime condition.';
}
