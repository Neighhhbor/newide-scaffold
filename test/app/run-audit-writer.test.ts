import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileRunAuditWriter } from '../../src/app/run-audit-writer';

const tempDirs: string[] = [];

describe('FileRunAuditWriter', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('initializes and appends one JSON event per line', async () => {
    const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'run-audit-'));
    tempDirs.push(runsRoot);
    const writer = new FileRunAuditWriter(runsRoot);
    const event = {
      sequence: 1,
      run_id: 'run_1',
      type: 'run.started',
      created_at: '2026-07-11T08:00:00.000Z',
      payload: { mode: 'single_agent' },
    };

    await writer.initialize('run_1');
    await writer.append(event);
    await writer.append({ ...event, sequence: 2, type: 'run.cancelled' });

    const contents = await readFile(path.join(runsRoot, 'run_1', 'audit.jsonl'), 'utf-8');
    expect(
      contents
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    ).toEqual([event, { ...event, sequence: 2, type: 'run.cancelled' }]);
  });

  it('does not truncate an existing audit when initialized again', async () => {
    const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'run-audit-'));
    tempDirs.push(runsRoot);
    const writer = new FileRunAuditWriter(runsRoot);
    const event = {
      sequence: 1,
      run_id: 'run_1',
      type: 'run.started',
      created_at: '2026-07-11T08:00:00.000Z',
      payload: {},
    };

    await writer.initialize('run_1');
    await writer.append(event);
    await writer.initialize('run_1');

    await expect(readFile(path.join(runsRoot, 'run_1', 'audit.jsonl'), 'utf-8')).resolves.toBe(
      `${JSON.stringify(event)}\n`,
    );
  });

  it('flushes all queued events for a run', async () => {
    const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'run-audit-'));
    tempDirs.push(runsRoot);
    const writer = new FileRunAuditWriter(runsRoot);
    const event = {
      sequence: 1,
      run_id: 'run_queued',
      type: 'run.started',
      created_at: '2026-07-11T08:00:00.000Z',
      payload: {},
    };

    void writer.append(event);
    void writer.append({ ...event, sequence: 2, type: 'run.failed' });
    await writer.flush('run_queued');

    const contents = await readFile(path.join(runsRoot, 'run_queued', 'audit.jsonl'), 'utf-8');
    expect(
      contents
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    ).toHaveLength(2);
  });
});
