import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, type Event } from '../src/core';
import {
  buildAgentCrashTelemetry,
  createTelemetryRecord,
  createTelemetryRecordFromEvent,
  getTelemetryCatalogEntry,
  observeCoordinationEvent,
  observeDriverRunResult,
} from '../src/telemetry';

describe('telemetry', () => {
  it('marks F-owned events separately from B/C observed events', () => {
    expect(getTelemetryCatalogEntry('eval.agent_crash')?.owner).toBe('F');
    expect(getTelemetryCatalogEntry('memory.extraction_completed')?.owner).toBe('B-owned-observed');
    expect(getTelemetryCatalogEntry('task.checkpoint_resume')?.owner).toBe('C-owned-observed');
  });

  it('builds F-owned agent crash telemetry without touching C state', () => {
    const emission = buildAgentCrashTelemetry({
      task_id: 'task_1',
      run_id: 'run_1',
      kill_at: 'after_tool_call',
      progress_pct: 50,
      tool_call_count: 5,
      had_checkpoint: true,
      kill_at_status: 'running',
      checkpoint_id_at_kill: 'checkpoint_1',
    });
    const record = createTelemetryRecord(emission);

    expect(record.owner).toBe('F');
    expect(record.event_type).toBe('eval.agent_crash');
    expect(record.payload).toMatchObject({
      progress_pct: 50,
      tool_call_count: 5,
      had_checkpoint: true,
    });
  });

  it('mirrors cataloged C events as C-owned observed telemetry', () => {
    const event: Event = {
      event_id: 'event_1',
      event_type: 'task.started',
      subject_id: 'task_1',
      task_id: 'task_1',
      run_id: 'run_1',
      payload: { source: 'resume' },
      created_at: '2026-06-22T00:00:00.000Z',
      schema_version: SCHEMA_VERSION,
    };

    expect(observeCoordinationEvent(event)).toMatchObject({
      event_type: 'task.started',
      subject_id: 'task_1',
      payload: { source: 'resume' },
    });
    expect(createTelemetryRecordFromEvent(event)?.owner).toBe('C-owned-observed');
  });

  it('does not mirror uncataloged implementation events', () => {
    const event: Event = {
      event_id: 'event_1',
      event_type: 'internal.debug',
      subject_id: 'debug_1',
      payload: {},
      created_at: '2026-06-22T00:00:00.000Z',
      schema_version: SCHEMA_VERSION,
    };

    expect(observeCoordinationEvent(event)).toBeUndefined();
    expect(createTelemetryRecordFromEvent(event)).toBeUndefined();
  });

  it('observes DriverReturn referenced experiences without owning B memory', () => {
    const emissions = observeDriverRunResult({
      task_id: 'task_1',
      run_id: 'run_1',
      driver_result: {
        driver_run_result_id: 'driver_result_1',
        session_id: 'session_1',
        status: 'succeeded',
        artifacts: [],
        transcript_ref: {
          artifact_id: 'artifact_1',
          type: 'transcript',
          uri: 'artifact://transcript/task_1/session_1',
          producer_id: 'mock-driver',
          task_id: 'task_1',
          created_at: '2026-06-22T00:00:00.000Z',
          schema_version: SCHEMA_VERSION,
        },
        tool_events: [],
        diagnostics: {
          driver_id: 'mock-driver',
          duration_ms: 1,
          notes: [],
        },
        created_at: '2026-06-22T00:00:00.000Z',
        schema_version: SCHEMA_VERSION,
      },
      driver_return: {
        referenced_experiences: [
          {
            experience_id: 'exp_1',
            applied: true,
            effectiveness: 'fully_effective',
            note: 'Helped choose the patch shape.',
          },
        ],
      },
    });

    expect(emissions.map((emission) => emission.event_type)).toEqual([
      'driver.run_result',
      'memory.experience_referenced',
    ]);
    expect(createTelemetryRecord(emissions[1]!).owner).toBe('B-owned-observed');
  });
});
