/** Append-only application run audit writer. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AppRunEvent } from './run-registry';

export interface RunAuditWriter {
  initialize(runId: string): Promise<void>;
  append(event: AppRunEvent): Promise<void>;
  flush(runId: string): Promise<void>;
}

export class FileRunAuditWriter implements RunAuditWriter {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly runsRoot = '.newide/runs') {}

  async initialize(runId: string): Promise<void> {
    const runDir = path.join(this.runsRoot, runId);
    await fs.mkdir(runDir, { recursive: true });
    const handle = await fs.open(path.join(runDir, 'audit.jsonl'), 'a');
    await handle.close();
  }

  append(event: AppRunEvent): Promise<void> {
    const previous = this.queues.get(event.run_id) ?? Promise.resolve();
    const next = previous.then(async () => {
      await this.initialize(event.run_id);
      await fs.appendFile(
        path.join(this.runsRoot, event.run_id, 'audit.jsonl'),
        `${JSON.stringify(event)}\n`,
        'utf-8',
      );
    });
    this.queues.set(event.run_id, next);
    return next.finally(() => {
      if (this.queues.get(event.run_id) === next) this.queues.delete(event.run_id);
    });
  }

  async flush(runId: string): Promise<void> {
    await (this.queues.get(runId) ?? Promise.resolve());
  }
}
