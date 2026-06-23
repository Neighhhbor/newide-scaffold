import { describe, expect, it } from 'vitest';
import {
  _coord,
  createInMemoryCoordinatorContract,
} from '../../src/coordinator/coordinator-contract';
import type { CoordinatorCheckpointRequest } from '../../src/coordinator/checkpoint-store';

describe('coordinator contract-facing API', () => {
  it('exposes task operations through the spec-c _coord namespace', () => {
    const coord = createInMemoryCoordinatorContract();

    const task = coord.task.create({
      spec: 'Create task through contract-facing API.',
      completion_criteria: ['Task is created through _coord.task.create.'],
    });

    expect(task.status).toBe('created');
    expect(coord.task.claim(task.task_id, 'agent_driver').status).toBe('claimed');
    expect(coord.task.update_status(task.task_id, 'running').status).toBe('running');
  });

  it('exposes mailbox operations through the spec-c _coord namespace', () => {
    const coord = createInMemoryCoordinatorContract();

    const sent = coord.message.send({
      thread_id: 'thread_1',
      from_agent_id: 'agent_source',
      to: [{ agent_id: 'agent_target' }],
      type: 'handoff',
      payload: { summary: 'Use the contract-facing mailbox API.' },
      requires_ack: true,
      deadline_seconds: 30,
    });

    expect(sent.message.message_id).toMatch(/^message_/);
    expect(sent.deliveries).toHaveLength(1);

    const ackResult = coord.message.ack(sent.message.message_id, {
      agent_id: 'agent_target',
    });

    expect(ackResult).toBeUndefined();
  });

  it('exposes checkpoint save through the long-running _coord state namespace', () => {
    const coord = createInMemoryCoordinatorContract();
    const task = coord.task.create({
      spec: 'Persist the long-running coordination boundary state.',
      completion_criteria: ['Checkpoint keeps team progress without agent model context.'],
    });

    const checkpoint = coord.state.checkpoint({
      thread_id: 'thread_checkpoint_1',
      task_id: task.task_id,
      agent_id: 'agent_driver',
      trigger: 'manual',
      checkpoint_type: 'full',
      schema_version: 'v0',
      message_thread: [
        {
          message_id: 'message_1',
          role: 'developer',
          content: 'Implementation reached review handoff.',
          turn: 1,
          artifact_refs: ['artifact_patch_1'],
        },
      ],
      scheduling: {
        policy: 'round_robin',
        current_turn: 2,
        next_agent_ref: 'reviewer',
        next_speaker_index: 1,
        agent_order: ['architect', 'developer', 'reviewer'],
      },
      se_domain_state: {
        review_threads: [],
        task_dag: {
          nodes: [{ id: task.task_id, status: 'running' }],
          edges: [],
        },
        adr_log: [],
      },
      mechanical_snapshot: {
        base_commit: 'base_commit',
        snapshot_commit: 'snapshot_commit',
        worktree_path: '/workspace/newide',
        branch: 'feat/mock-coordinator',
        modified_files: ['src/coordinator/coordinator-contract.ts'],
      },
      semantic_handoff: {
        done: ['task created', 'message sent'],
        in_progress: ['review handoff'],
        blocked_on: [],
        assumptions: ['driver state is reconstructed from message thread'],
        next_steps: ['resume reviewer turn'],
        known_risks: ['checkpoint is in-memory in this MVP'],
      },
      runtime_state: {
        scheduler_policy: 'round_robin',
        current_turn: 2,
        next_agent_ref: 'reviewer',
        resume_cursor: 'reviewer_turn',
      },
      interrupt_state: {
        waiting_for: ['human_review'],
        timeout_at: '2026-06-23T08:00:00.000Z',
        resume_condition: 'reviewer approved',
      },
      artifact_refs: {
        git_commit_hash: 'snapshot_commit',
        patch_artifact_id: 'artifact_patch_1',
      },
    });

    expect(checkpoint).toMatchObject({
      checkpoint_type: 'full',
      thread_id: 'thread_checkpoint_1',
      task_id: task.task_id,
      agent_id: 'agent_driver',
      trigger: 'manual',
      validity_status: 'valid',
      schema_version: 'v0',
      message_thread: [
        expect.objectContaining({
          message_id: 'message_1',
          role: 'developer',
          turn: 1,
        }),
      ],
      scheduling: {
        policy: 'round_robin',
        current_turn: 2,
        next_agent_ref: 'reviewer',
        next_speaker_index: 1,
        agent_order: ['architect', 'developer', 'reviewer'],
      },
      mechanical_snapshot: expect.objectContaining({
        snapshot_commit: 'snapshot_commit',
      }),
      semantic_handoff: expect.objectContaining({
        next_steps: ['resume reviewer turn'],
      }),
      runtime_state: expect.objectContaining({
        resume_cursor: 'reviewer_turn',
      }),
      artifact_refs: {
        git_commit_hash: 'snapshot_commit',
        patch_artifact_id: 'artifact_patch_1',
      },
      interrupt_state: expect.objectContaining({
        waiting_for: ['human_review'],
      }),
    });
    expect(checkpoint.checkpoint_id).toMatch(/^checkpoint_/);
    expect(checkpoint.se_domain_state).not.toHaveProperty('model_context');
  });

  it('rejects checkpoint payloads that try to persist agent model context', () => {
    const coord = createInMemoryCoordinatorContract();
    const task = coord.task.create({
      spec: 'Reject private agent state in checkpoint.',
      completion_criteria: ['model_context is not persisted by C checkpoint.'],
    });

    expect(() =>
      coord.state.checkpoint({
        thread_id: 'thread_checkpoint_2',
        task_id: task.task_id,
        trigger: 'manual',
        checkpoint_type: 'full',
        schema_version: 'v0',
        message_thread: [],
        scheduling: {
          policy: 'single_agent',
          current_turn: 0,
        },
        se_domain_state: {
          model_context: ['private token history'],
        },
        mechanical_snapshot: {
          base_commit: 'base_commit',
          worktree_path: '/workspace/newide',
          branch: 'feat/mock-coordinator',
          modified_files: [],
        },
        semantic_handoff: {
          done: [],
          in_progress: [],
          blocked_on: [],
          assumptions: [],
          next_steps: [],
          known_risks: [],
        },
      }),
    ).toThrow('Checkpoint must not include forbidden key: model_context');
  });

  it('keeps incremental checkpoint as an explicit not-implemented placeholder', () => {
    const coord = createInMemoryCoordinatorContract();
    const task = coord.task.create({
      spec: 'Reject unsupported incremental checkpoint in MVP.',
      completion_criteria: ['Incremental replay is not silently accepted.'],
    });

    expect(() =>
      coord.state.checkpoint({
        thread_id: 'thread_checkpoint_3',
        task_id: task.task_id,
        trigger: 'manual',
        checkpoint_type: 'incremental',
        schema_version: 'v0',
        message_thread: [],
        scheduling: {
          policy: 'single_agent',
          current_turn: 0,
        },
        se_domain_state: {},
        mechanical_snapshot: {
          base_commit: 'base_commit',
          worktree_path: '/workspace/newide',
          branch: 'feat/mock-coordinator',
          modified_files: [],
        },
        semantic_handoff: {
          done: [],
          in_progress: [],
          blocked_on: [],
          assumptions: [],
          next_steps: [],
          known_risks: [],
        },
      }),
    ).toThrow('Incremental checkpoint is not implemented yet');
  });

  it('loads latest checkpoint and lists checkpoint history by thread', () => {
    const coord = createInMemoryCoordinatorContract();
    const task = coord.task.create({
      spec: 'Keep checkpoint history by thread.',
      completion_criteria: ['History can be listed and latest can be loaded.'],
    });

    const firstCheckpoint = coord.state.checkpoint(
      checkpointRequest(task.task_id, 'thread_history', {
        message_thread: [{ role: 'architect', content: 'Design done.', turn: 1 }],
        scheduling: {
          policy: 'round_robin',
          current_turn: 1,
        },
      }),
    );
    const secondCheckpoint = coord.state.checkpoint(
      checkpointRequest(task.task_id, 'thread_history', {
        parent_checkpoint_id: firstCheckpoint.checkpoint_id,
        message_thread: [
          { role: 'architect', content: 'Design done.', turn: 1 },
          { role: 'developer', content: 'Implementation started.', turn: 2 },
        ],
        scheduling: {
          policy: 'round_robin',
          current_turn: 2,
        },
      }),
    );

    expect(coord.state.load('thread_history')?.checkpoint_id).toBe(secondCheckpoint.checkpoint_id);
    expect(coord.state.load('thread_history', firstCheckpoint.checkpoint_id)?.checkpoint_id).toBe(
      firstCheckpoint.checkpoint_id,
    );
    expect(coord.state.load('other_thread', firstCheckpoint.checkpoint_id)).toBeUndefined();

    expect(coord.state.list_history('thread_history')).toMatchObject([
      {
        checkpoint_id: firstCheckpoint.checkpoint_id,
        parent_checkpoint_id: null,
        checkpoint_type: 'full',
        schema_version: 'v0',
        trigger: 'manual',
        message_count: 1,
        turn_count: 1,
      },
      {
        checkpoint_id: secondCheckpoint.checkpoint_id,
        parent_checkpoint_id: firstCheckpoint.checkpoint_id,
        checkpoint_type: 'full',
        schema_version: 'v0',
        trigger: 'manual',
        message_count: 2,
        turn_count: 2,
      },
    ]);
    expect(coord.state.list_history('thread_history', { limit: 1, offset: 1 })).toMatchObject([
      {
        checkpoint_id: secondCheckpoint.checkpoint_id,
      },
    ]);
  });

  it('keeps checkpoint fork as an explicit not-implemented placeholder', () => {
    const coord = createInMemoryCoordinatorContract();
    const task = coord.task.create({
      spec: 'Expose checkpoint fork placeholder.',
      completion_criteria: ['Fork is not silently accepted before it is implemented.'],
    });
    const checkpoint = coord.state.checkpoint(checkpointRequest(task.task_id, 'thread_fork'));

    expect(() =>
      coord.state.fork('thread_fork', checkpoint.checkpoint_id, 'thread_fork_next'),
    ).toThrow('checkpoint.fork is not implemented yet');
  });

  it('keeps the exported _coord namespace available as the default instance', () => {
    expect(_coord.task.create).toBeTypeOf('function');
    expect(_coord.message.send).toBeTypeOf('function');
    expect(_coord.state.checkpoint).toBeTypeOf('function');
    expect(_coord.state.load).toBeTypeOf('function');
    expect(_coord.state.list_history).toBeTypeOf('function');
    expect(_coord.state.fork).toBeTypeOf('function');
  });
});

function checkpointRequest(
  taskId: string,
  threadId: string,
  overrides: Partial<CoordinatorCheckpointRequest> = {},
): CoordinatorCheckpointRequest {
  return {
    thread_id: threadId,
    task_id: taskId,
    trigger: 'manual',
    checkpoint_type: 'full',
    schema_version: 'v0',
    message_thread: [],
    scheduling: {
      policy: 'single_agent',
      current_turn: 0,
    },
    se_domain_state: {},
    mechanical_snapshot: {
      base_commit: 'base_commit',
      worktree_path: '/workspace/newide',
      branch: 'feat/mock-coordinator',
      modified_files: [],
    },
    semantic_handoff: {
      done: [],
      in_progress: [],
      blocked_on: [],
      assumptions: [],
      next_steps: [],
      known_risks: [],
    },
    ...overrides,
  };
}
