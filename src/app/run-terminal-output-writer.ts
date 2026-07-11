/** Writes fallback terminal artifacts when the integration flow cannot finalize itself. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AppRunSnapshot } from './run-registry';

export interface RunTerminalOutputWriter {
  finalize(snapshot: AppRunSnapshot): Promise<void>;
}

export class FileRunTerminalOutputWriter implements RunTerminalOutputWriter {
  constructor(private readonly runsRoot = '.newide/runs') {}

  async finalize(snapshot: AppRunSnapshot): Promise<void> {
    if (snapshot.status !== 'failed' && snapshot.status !== 'cancelled') return;
    const runDir = path.join(this.runsRoot, snapshot.run_id);
    await fs.mkdir(runDir, { recursive: true });
    const resultPath = path.join(runDir, 'result.json');
    const timelinePath = path.join(runDir, 'timeline.json');
    const frontendSnapshotPath = path.join(runDir, 'frontend-snapshot.json');

    await Promise.all([
      writeJsonIfMissing(resultPath, {
        run_id: snapshot.run_id,
        task_id: snapshot.task_id,
        status: snapshot.status,
        mode: snapshot.mode,
        errors: snapshot.error ? [snapshot.error] : [],
        result_path: resultPath,
        timeline_path: timelinePath,
        audit_path: path.join(runDir, 'audit.jsonl'),
        frontend_snapshot_path: frontendSnapshotPath,
        schema_version: snapshot.schema_version,
      }),
      writeJsonIfMissing(timelinePath, snapshot.events),
      writeJsonIfMissing(frontendSnapshotPath, snapshot),
    ]);
  }
}

async function writeJsonIfMissing(filePath: string, value: unknown): Promise<void> {
  try {
    await fs.writeFile(filePath, JSON.stringify(value, null, 2), { encoding: 'utf-8', flag: 'wx' });
  } catch (error) {
    if (isAlreadyExistsError(error)) return;
    throw error;
  }
}

function isAlreadyExistsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}
