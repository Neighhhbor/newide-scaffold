import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { runSnapshotSchema } from '../../src/protocol/run-snapshot';
import { projectRunSnapshot } from '../../src/app/run-snapshot-projector';

describe('RunSnapshot protocol', () => {
  it('keeps the cancelled fixture compatible with the runtime schema', async () => {
    const fixture = JSON.parse(
      await readFile('fixtures/protocol/run-snapshot-cancelled.json', 'utf-8'),
    );
    expect(runSnapshotSchema.parse(fixture)).toEqual(fixture);
  });

  it('projects internal failure state into stable errors and final output', () => {
    const projected = projectRunSnapshot({
      schema_version: 'v0',
      revision: 1,
      run_id: 'run_failed',
      task_id: 'task_failed',
      status: 'failed',
      mode: 'council',
      current: { stage: 'intervention', active_node_code: 'N18' },
      events: [],
      error: {
        code: 'RUNNER_FAILED',
        message: 'driver exited',
        details: { phase: 'driver', retryable: false },
      },
    });

    expect(projected).toMatchObject({
      run_id: 'run_failed',
      task_id: 'task_failed',
      mode: 'council',
      status: 'failed',
      council: { enabled: true, status: 'failed', can_create_merge_authorization: false },
      errors: [
        {
          code: 'RUNNER_FAILED',
          message: 'driver exited',
          details: { phase: 'driver', retryable: false },
        },
      ],
      final_output: { status: 'failed', artifact_refs: [], files_written: [] },
    });
    expect(runSnapshotSchema.parse(projected)).toEqual(projected);
  });
});
