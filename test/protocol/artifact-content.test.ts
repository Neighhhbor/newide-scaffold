import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { artifactContentSchema } from '../../src/protocol/artifact-content';

describe('ArtifactContent protocol', () => {
  it('keeps the copyable fixture compatible with the runtime schema', async () => {
    const fixture = JSON.parse(await readFile('fixtures/protocol/artifact-content.json', 'utf-8'));
    expect(artifactContentSchema.parse(fixture)).toEqual(fixture);
  });
});
