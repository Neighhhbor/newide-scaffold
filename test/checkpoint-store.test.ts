import { describe, it, expect } from 'vitest';
import { SCHEMA_VERSION, createId, nowTimestamp, type Checkpoint } from '../src/core';
import { InMemoryCheckpointStore } from '../src/coordinator';

function makeCheckpoint(overrides: Partial<Checkpoint> & { run_id: string }): Checkpoint {
  return {
    checkpoint_id: createId('checkpoint'),
    checkpoint_type: 'full',
    task_id: 'task_test',
    run_id: overrides.run_id,
    trigger: 'manual',
    mechanical_snapshot: {
      base_commit: 'base',
      worktree_path: '.',
      branch: 'main',
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
    artifact_refs: [],
    validity_status: 'valid',
    created_at: nowTimestamp(),
    schema_version: SCHEMA_VERSION,
    ...overrides,
  };
}

describe('InMemoryCheckpointStore', () => {
  it('save then get returns the same checkpoint', () => {
    const store = new InMemoryCheckpointStore();
    const checkpoint = makeCheckpoint({ run_id: 'run_1' });
    const saved = store.save(checkpoint);
    expect(saved).toEqual(checkpoint);
    expect(store.get(checkpoint.checkpoint_id)).toEqual(checkpoint);
  });

  it('save is idempotent: same checkpoint_id overwrites', () => {
    const store = new InMemoryCheckpointStore();
    const original = makeCheckpoint({ run_id: 'run_1' });
    store.save(original);
    const updated: Checkpoint = {
      ...original,
      semantic_handoff: {
        ...original.semantic_handoff,
        done: ['updated'],
      },
    };
    store.save(updated);
    expect(store.list()).toHaveLength(1);
    expect(store.get(original.checkpoint_id)?.semantic_handoff.done).toEqual(['updated']);
  });

  it('getLatestByRun returns the newest non-superseded checkpoint', () => {
    const store = new InMemoryCheckpointStore();
    const older = makeCheckpoint({
      run_id: 'run_1',
      checkpoint_id: 'ckpt_old',
      created_at: '2026-07-03T10:00:00.000Z',
    });
    const newer = makeCheckpoint({
      run_id: 'run_1',
      checkpoint_id: 'ckpt_new',
      created_at: '2026-07-03T11:00:00.000Z',
    });
    store.save(older);
    store.save(newer);
    expect(store.getLatestByRun('run_1')?.checkpoint_id).toBe('ckpt_new');
  });

  it('getLatestByRun skips superseded checkpoints', () => {
    const store = new InMemoryCheckpointStore();
    const superseded = makeCheckpoint({
      run_id: 'run_1',
      checkpoint_id: 'ckpt_super',
      created_at: '2026-07-03T12:00:00.000Z',
      validity_status: 'superseded',
    });
    const valid = makeCheckpoint({
      run_id: 'run_1',
      checkpoint_id: 'ckpt_valid',
      created_at: '2026-07-03T11:00:00.000Z',
    });
    store.save(superseded);
    store.save(valid);
    expect(store.getLatestByRun('run_1')?.checkpoint_id).toBe('ckpt_valid');
  });

  it('getLatestByRun returns undefined for unknown run', () => {
    const store = new InMemoryCheckpointStore();
    store.save(makeCheckpoint({ run_id: 'run_1' }));
    expect(store.getLatestByRun('run_unknown')).toBeUndefined();
  });

  it('getLatestByRun isolates runs', () => {
    const store = new InMemoryCheckpointStore();
    const run1Latest = makeCheckpoint({
      run_id: 'run_1',
      checkpoint_id: 'ckpt_r1',
      created_at: '2026-07-03T10:00:00.000Z',
    });
    const run2Latest = makeCheckpoint({
      run_id: 'run_2',
      checkpoint_id: 'ckpt_r2',
      created_at: '2026-07-03T11:00:00.000Z',
    });
    store.save(run1Latest);
    store.save(run2Latest);
    expect(store.getLatestByRun('run_1')?.checkpoint_id).toBe('ckpt_r1');
    expect(store.getLatestByRun('run_2')?.checkpoint_id).toBe('ckpt_r2');
  });

  it('listByRun returns run checkpoints in created_at ascending order', () => {
    const store = new InMemoryCheckpointStore();
    const middle = makeCheckpoint({
      run_id: 'run_1',
      checkpoint_id: 'ckpt_mid',
      created_at: '2026-07-03T11:00:00.000Z',
    });
    const oldest = makeCheckpoint({
      run_id: 'run_1',
      checkpoint_id: 'ckpt_old',
      created_at: '2026-07-03T10:00:00.000Z',
    });
    const newest = makeCheckpoint({
      run_id: 'run_1',
      checkpoint_id: 'ckpt_new',
      created_at: '2026-07-03T12:00:00.000Z',
    });
    store.save(middle);
    store.save(oldest);
    store.save(newest);
    const history = store.listByRun('run_1');
    expect(history.map((c) => c.checkpoint_id)).toEqual(['ckpt_old', 'ckpt_mid', 'ckpt_new']);
  });

  it('listByRun isolates runs (includes superseded)', () => {
    const store = new InMemoryCheckpointStore();
    store.save(
      makeCheckpoint({
        run_id: 'run_1',
        checkpoint_id: 'ckpt_r1',
        created_at: '2026-07-03T10:00:00.000Z',
      }),
    );
    store.save(
      makeCheckpoint({
        run_id: 'run_2',
        checkpoint_id: 'ckpt_r2',
        created_at: '2026-07-03T11:00:00.000Z',
        validity_status: 'superseded',
      }),
    );
    expect(store.listByRun('run_1').map((c) => c.checkpoint_id)).toEqual(['ckpt_r1']);
    expect(store.listByRun('run_2').map((c) => c.checkpoint_id)).toEqual(['ckpt_r2']);
  });

  it('list returns all checkpoints in created_at ascending order', () => {
    const store = new InMemoryCheckpointStore();
    const b = makeCheckpoint({
      run_id: 'run_1',
      checkpoint_id: 'ckpt_b',
      created_at: '2026-07-03T11:00:00.000Z',
    });
    const a = makeCheckpoint({
      run_id: 'run_2',
      checkpoint_id: 'ckpt_a',
      created_at: '2026-07-03T10:00:00.000Z',
    });
    store.save(b);
    store.save(a);
    expect(store.list().map((c) => c.checkpoint_id)).toEqual(['ckpt_a', 'ckpt_b']);
  });
});
