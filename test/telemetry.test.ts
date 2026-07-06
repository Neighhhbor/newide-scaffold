import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, type Event } from '../src/core';
import {
  buildAgentCrashTelemetry,
  buildProxyUsageTelemetry,
  buildSweBenchVerifiedEvaluationTelemetry,
  buildTestbedRegressionTelemetry,
  createTelemetryRecord,
  createTelemetryRecordFromEvent,
  getTelemetryCatalogEntry,
  observeCoordinationEvent,
  observeCouncilRound,
  observeCoordinationTrace,
  observeDecisionPacket,
  observeDriverRunResult,
  observeTokenTracker,
} from '../src/telemetry';

describe('telemetry', () => {
  it('marks F-owned events separately from B/C observed events', () => {
    expect(getTelemetryCatalogEntry('eval.agent_crash')?.owner).toBe('F');
    expect(getTelemetryCatalogEntry('memory.extraction_completed')?.owner).toBe('B-owned-observed');
    expect(getTelemetryCatalogEntry('task.checkpoint_resume')?.owner).toBe('C-owned-observed');
    expect(getTelemetryCatalogEntry('council.decision')?.owner).toBe('C-owned-observed');
    expect(getTelemetryCatalogEntry('harness.swe_bench_verified_evaluated')?.owner).toBe('F');
  });

  it('registers §3 council and §4 harness event types in catalog', () => {
    const councilEvents = [
      'council.decision',
      'council.started',
      'council.review_round_end',
      'council.extraction_completed',
      'council.completed',
      'task.escalated',
      'audit.coordination_trace_observed',
      'audit.decision_packet_observed',
      'audit.token_tracker_observed',
    ];
    for (const eventType of councilEvents) {
      expect(getTelemetryCatalogEntry(eventType)).toBeDefined();
    }

    expect(getTelemetryCatalogEntry('harness.swe_bench_verified_evaluated')).toMatchObject({
      owner: 'F',
      level: 'L1_HARNESS',
    });
    expect(getTelemetryCatalogEntry('harness.testbed_regression_checked')).toMatchObject({
      owner: 'F',
      level: 'L1_HARNESS',
    });
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

  it('builds §4 SWE-bench Verified and testbed regression L1 telemetry', () => {
    const sweBench = createTelemetryRecord(
      buildSweBenchVerifiedEvaluationTelemetry({
        case_id: 'django__django-1234',
        exit_code: 0,
        fail_to_pass_status: 'all_passed',
        pass_to_pass_status: 'all_passed',
        passed: true,
        scaffold_variant: 'full_system',
        case_tier: 'medium',
        council_topology: 'A1_full_mesh',
      }),
    );
    expect(sweBench.event_type).toBe('harness.swe_bench_verified_evaluated');
    expect(sweBench.owner).toBe('F');
    expect(sweBench.payload).toMatchObject({
      passed: true,
      'council.topology': 'A1_full_mesh',
    });

    const regression = createTelemetryRecord(
      buildTestbedRegressionTelemetry({
        case_id: 'django__django-1234',
        pass_to_pass_regressed: true,
        regressed_tests: ['test_foo'],
      }),
    );
    expect(regression.event_type).toBe('harness.testbed_regression_checked');
    expect(regression.payload.regressed_tests).toEqual(['test_foo']);
  });

  it('extends proxy usage telemetry with Fair-Setup audit fields', () => {
    const record = createTelemetryRecord(
      buildProxyUsageTelemetry({
        case_id: 'case_1',
        input_tokens: 100,
        output_tokens: 50,
        scaffold_variant: 'full_system',
        temperature: 0.2,
        seed: 42,
      }),
    );
    expect(record.payload).toMatchObject({
      scaffold_variant: 'full_system',
      temperature: 0.2,
      seed: 42,
    });
  });

  it('observes council adapter shapes without calling Council business logic', () => {
    const roundEnd = observeCouncilRound({
      phase: 'review_round_end',
      council_id: 'council_1',
      task_id: 'task_1',
      current_round_count: 2,
      round_participants: ['agent_a', 'agent_b'],
    });
    expect(roundEnd.event_type).toBe('council.review_round_end');
    expect(createTelemetryRecord(roundEnd).owner).toBe('C-owned-observed');

    const started = observeCouncilRound({
      phase: 'started',
      council_id: 'council_1',
      trigger: 'gate_defer',
      decision_mode: 'consensus',
      topology: 'A1_full_mesh',
      participant_ids: ['agent_a'],
    });
    expect(started.event_type).toBe('council.started');

    const decisionPacket = observeDecisionPacket({
      council_id: 'council_1',
      identity_mapping: { blind_a: 'gpt-4o' },
      final_selected_driver: 'driver_light',
      judge_raw_scores: { proposal_1: 0.9 },
      judge_rationale_text: 'Strong evidence for patch A.',
    });
    expect(decisionPacket.event_type).toBe('audit.decision_packet_observed');
    expect(createTelemetryRecord(decisionPacket).payload).toMatchObject({
      final_selected_driver: 'driver_light',
    });

    const trace = observeCoordinationTrace({
      council_id: 'council_1',
      current_round_count: 3,
      termination_reason: 'consensus',
      is_escalated: false,
    });
    expect(trace.event_type).toBe('audit.coordination_trace_observed');

    const tokens = observeTokenTracker({
      council_id: 'council_1',
      raw_input_tokens: 1000,
      extracted_input_tokens: 600,
      context_extraction_saved_tokens: 400,
      total_input_tokens: 600,
      total_output_tokens: 200,
    });
    expect(tokens.event_type).toBe('audit.token_tracker_observed');
    expect(createTelemetryRecord(tokens).payload.context_extraction_saved_tokens).toBe(400);
  });

  it('mirrors cataloged council.decision events from EventStore', () => {
    const event: Event = {
      event_id: 'event_council',
      event_type: 'council.decision',
      subject_id: 'decision_1',
      task_id: 'task_1',
      run_id: 'run_1',
      payload: {
        selected_proposal_id: 'proposal_1',
        verdict: 'select',
      },
      created_at: '2026-06-22T00:00:00.000Z',
      schema_version: SCHEMA_VERSION,
    };

    expect(observeCoordinationEvent(event)).toMatchObject({
      event_type: 'council.decision',
      payload: { verdict: 'select' },
    });
    expect(createTelemetryRecordFromEvent(event)?.owner).toBe('C-owned-observed');
  });
});
