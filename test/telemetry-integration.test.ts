import { describe, expect, it } from 'vitest';
import { runBasicFlow } from '../src/coordinator/basic-flow';
import { RuntimeOrchestrator } from '../src/coordinator/orchestrator';
import { SCHEMA_VERSION, createId, nowTimestamp } from '../src/core';
import { HashEmbeddingProvider } from '../src/memory/adapters/hash-embedding-provider';
import { InMemoryRepository } from '../src/memory/adapters/in-memory-repository';
import { InMemoryBufferRepository } from '../src/memory/adapters/in-memory-buffer-repository';
import { createAgentMemoryScope } from '../src/memory/adapters/agent-memory-scope';
import { defaultMvpAgentRunDeps } from '../src/memory/mvp/default-agent-run-deps';
import { runTaskMemoryCycle } from '../src/memory/services/memory-cycle';
import { InMemoryTelemetrySink, createFHarnessTelemetryPort } from '../src/telemetry';

describe('telemetry integration', () => {
  it('mirrors cataloged coordinator events and checkpoint L3 observations from basic flow', async () => {
    const sink = new InMemoryTelemetrySink();
    await runBasicFlow({ telemetry: sink });

    const eventTypes = sink.list().map((record) => record.event_type);
    expect(eventTypes).toContain('task.created');
    expect(eventTypes).toContain('memory.context_pack_built');
    expect(eventTypes).toContain('driver.run_result');
    expect(eventTypes).toContain('checkpoint.saved');
    expect(eventTypes).toContain('coord.checkpoint_observed');

    const taskCreated = sink.list().find((record) => record.event_type === 'task.created');
    expect(taskCreated?.owner).toBe('C-owned-observed');

    const checkpointObserved = sink
      .list()
      .find((record) => record.event_type === 'coord.checkpoint_observed');
    expect(checkpointObserved?.payload).toMatchObject({
      checkpoint_id: expect.any(String),
      semantic_handoff: expect.any(Object),
    });
  });

  it('records memory-cycle B-owned observations without requiring EventStore events', async () => {
    const sink = new InMemoryTelemetrySink();
    const repository = new InMemoryRepository(new HashEmbeddingProvider());
    const bufferRepository = new InMemoryBufferRepository();
    await repository.initializeAgent({
      role_id: 'role_telemetry',
      name: 'Telemetry Agent',
    });
    await bufferRepository.ensureAgent('role_telemetry');
    const memory = createAgentMemoryScope(repository, bufferRepository, 'role_telemetry');

    await runTaskMemoryCycle(
      memory,
      { spec: 'telemetry memory cycle', scenario: 'promotion_ready' },
      { ...defaultMvpAgentRunDeps, telemetry: sink },
      { memory_ablation: 'B2' },
    );

    const eventTypes = sink.list().map((record) => record.event_type);
    expect(eventTypes).toEqual(
      expect.arrayContaining([
        'memory.context_pack_built',
        'driver.run_result',
        'buffer.report_received',
        'memory.extraction_triggered',
        'memory.extraction_completed',
        'metrics.updated',
      ]),
    );

    const contextPack = sink
      .list()
      .find((record) => record.event_type === 'memory.context_pack_built');
    expect(contextPack?.payload).toMatchObject({
      ablation: 'B2',
      retrieved_experience_ids: expect.any(Array),
      retrieved_skill_ids: expect.any(Array),
    });
  });

  it('accepts L1 harness records through FHarnessTelemetryPort', async () => {
    const sink = new InMemoryTelemetrySink();
    const port = createFHarnessTelemetryPort(sink);

    await port.recordSweEvoEvaluation({
      instance_id: 'instance_1',
      instance_seq: 1,
      resolved: true,
      applied: true,
      p2p_regression: false,
      memory_ablation: 'B1',
    });

    await port.recordAgentCrash({
      task_id: 'task_1',
      kill_at: 'after_tool_call',
      progress_pct: 42,
      tool_call_count: 3,
      had_checkpoint: true,
      kill_at_status: 'running',
    });

    expect(sink.list().map((record) => record.event_type)).toEqual([
      'harness.swe_evo_evaluated',
      'eval.agent_crash',
    ]);
    expect(sink.list().every((record) => record.owner === 'F')).toBe(true);
  });

  it('mirrors orchestrator appendEvent for cataloged C events only', () => {
    const sink = new InMemoryTelemetrySink();
    const orchestrator = new RuntimeOrchestrator({ telemetry: sink });

    orchestrator.appendEvent({
      event_type: 'task.started',
      subject_id: 'task_1',
      task_id: 'task_1',
      payload: { source: 'resume' },
    });
    orchestrator.appendEvent({
      event_type: 'internal.debug',
      subject_id: 'debug_1',
      payload: {},
    });

    expect(sink.list()).toHaveLength(1);
    expect(sink.list()[0]).toMatchObject({
      event_type: 'task.started',
      owner: 'C-owned-observed',
      payload: { source: 'resume' },
    });
  });

  it('observes checkpoint fields when saveCheckpoint is called', () => {
    const sink = new InMemoryTelemetrySink();
    const orchestrator = new RuntimeOrchestrator({ telemetry: sink });
    const task = orchestrator.createTask({ spec: 'checkpoint telemetry' });
    const checkpoint = orchestrator.saveCheckpoint({
      checkpoint_id: createId('checkpoint'),
      checkpoint_type: 'full',
      task_id: task.task_id,
      trigger: 'manual',
      mechanical_snapshot: {
        base_commit: 'abc',
        worktree_path: '.',
        branch: 'main',
        modified_files: [],
      },
      semantic_handoff: {
        done: ['step-1'],
        in_progress: [],
        blocked_on: [],
        assumptions: [],
        next_steps: [],
        known_risks: [],
      },
      artifact_refs: [],
      validity_status: 'valid',
      created_at: nowTimestamp(),
      schema_version: SCHEMA_VERSION,
    });

    const records = sink.list();
    expect(records.some((record) => record.event_type === 'checkpoint.saved')).toBe(true);
    expect(records.some((record) => record.event_type === 'coord.checkpoint_observed')).toBe(true);
    expect(
      records.find((record) => record.event_type === 'coord.checkpoint_observed')?.payload,
    ).toMatchObject({
      checkpoint_id: checkpoint.checkpoint_id,
      semantic_handoff: { done: ['step-1'] },
    });
  });
});
