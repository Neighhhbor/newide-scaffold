import { describe, expect, it } from 'vitest';
import { buildArtifactOutputs } from '../../src/coordinator/artifact-output';
import { SCHEMA_VERSION, type ArtifactRef } from '../../src/core';

describe('buildArtifactOutputs', () => {
  it('should summarize source path and materialized record path', () => {
    const artifact = createArtifact({
      artifact_id: 'artifact_001',
      metadata: { path: '.newide/acp-smoke/result.txt' },
    });

    const outputs = buildArtifactOutputs({
      artifacts: [artifact],
      materialized_record_paths: [
        '.newide/worktrees/task_001/artifact_001.json',
        '.newide/worktrees/task_001/artifact_002.json',
      ],
    });

    expect(outputs).toEqual([
      {
        artifact_id: 'artifact_001',
        type: 'diff',
        uri: 'artifact://diff/task_001/result.txt',
        source_path: '.newide/acp-smoke/result.txt',
        materialized_record_path: '.newide/worktrees/task_001/artifact_001.json',
      },
    ]);
  });

  it('should omit optional paths when the source metadata or record is missing', () => {
    const outputs = buildArtifactOutputs({
      artifacts: [createArtifact({ artifact_id: 'artifact_missing', metadata: { path: 42 } })],
      materialized_record_paths: ['.newide/worktrees/task_001/other.json'],
    });

    expect(outputs).toEqual([
      {
        artifact_id: 'artifact_missing',
        type: 'diff',
        uri: 'artifact://diff/task_001/result.txt',
      },
    ]);
  });
});

type ArtifactRefOverrides = Pick<ArtifactRef, 'artifact_id'> &
  Partial<Omit<ArtifactRef, 'artifact_id'>>;

function createArtifact({ artifact_id, ...overrides }: ArtifactRefOverrides): ArtifactRef {
  return {
    artifact_id,
    type: 'diff',
    uri: 'artifact://diff/task_001/result.txt',
    producer_id: 'driver_001',
    task_id: 'task_001',
    created_at: '2026-07-07T00:00:00.000Z',
    schema_version: SCHEMA_VERSION,
    ...overrides,
  };
}
