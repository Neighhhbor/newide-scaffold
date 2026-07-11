import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { projectRunEventSource, runEventSchema } from '../../src/protocol/run-event';

describe('RunEvent protocol projection', () => {
  it.each([
    ['run.started', 'coordinator'],
    ['agent.completed', 'agent'],
    ['driver.run_result', 'driver'],
    ['memory.context_pack_built', 'memory'],
    ['gate.result', 'gate'],
    ['council.decision', 'council'],
  ] as const)('maps %s to %s', (type, source) => {
    expect(projectRunEventSource(type)).toBe(source);
  });

  it('keeps the frontend fixture compatible with the runtime schema', async () => {
    const fixture = JSON.parse(await readFile('fixtures/protocol/run-event.json', 'utf-8'));
    expect(runEventSchema.parse(fixture)).toEqual(fixture);
  });
});
