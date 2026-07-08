/**
 * ================================================
 * Audit Configuration
 * ================================================
 * Built-in audit sink implementations.
 */

import type { AuditSink, AuditRecord } from './types';

/** Console audit sink — logs to stdout/stderr */
export class ConsoleAuditSink implements AuditSink {
  constructor(private readonly verbose = false) {}

  onCallStart(record: AuditRecord): void {
    if (this.verbose) {
      console.log(`[AUDIT][START] ${record.callId} | task=${record.task} | model=${record.model}`);
    }
  }

  onCallSuccess(record: AuditRecord): void {
    const usage = record.usage
      ? `tokens=${record.usage.total_tokens}(${record.usage.prompt_tokens}+${record.usage.completion_tokens})`
      : 'tokens=N/A';
    console.log(
      `[AUDIT][SUCCESS] ${record.callId} | task=${record.task} | model=${record.model} | ${usage} | ${record.durationMs}ms`,
    );
  }

  onCallFailure(record: AuditRecord): void {
    const err = record.error
      ? `code=${record.error.code} retryable=${record.error.retryable}`
      : 'unknown error';
    console.error(
      `[AUDIT][FAILED] ${record.callId} | task=${record.task} | model=${record.model} | ${err} | ${record.durationMs}ms`,
    );
  }
}

/** In-memory audit sink — collects records for programmatic inspection */
export class MemoryAuditSink implements AuditSink {
  private readonly records: AuditRecord[] = [];

  onCallStart(record: AuditRecord): void {
    this.records.push(record);
  }

  onCallSuccess(record: AuditRecord): void {
    const existing = this.records.find((r) => r.callId === record.callId);
    if (existing) {
      Object.assign(existing, record);
    }
  }

  onCallFailure(record: AuditRecord): void {
    const existing = this.records.find((r) => r.callId === record.callId);
    if (existing) {
      Object.assign(existing, record);
    }
  }

  getAll(): AuditRecord[] {
    return [...this.records];
  }

  getFailures(): AuditRecord[] {
    return this.records.filter((r) => r.status === 'failed');
  }

  getByTask(task: string): AuditRecord[] {
    return this.records.filter((r) => r.task === task);
  }

  clear(): void {
    this.records.length = 0;
  }
}

/** File audit sink — writes JSON lines to a log file */
export class FileAuditSink implements AuditSink {
  private buffer: string[] = [];
  private flushTimer?: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly filePath: string,
    private readonly flushIntervalMs = 5000,
  ) {}

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flush(), this.flushIntervalMs);
  }

  private async flush(): Promise<void> {
    this.flushTimer = undefined;
    if (this.buffer.length === 0) return;

    const lines = this.buffer.splice(0, this.buffer.length).join('\n') + '\n';
    try {
      const fs = await import('fs/promises');
      await fs.appendFile(this.filePath, lines, 'utf-8');
    } catch (e) {
      console.error('[FileAuditSink] flush failed:', e);
    }
  }

  onCallStart(record: AuditRecord): void {
    this.buffer.push(JSON.stringify(record));
    this.scheduleFlush();
  }

  onCallSuccess(record: AuditRecord): void {
    this.buffer.push(JSON.stringify(record));
    this.scheduleFlush();
  }

  onCallFailure(record: AuditRecord): void {
    this.buffer.push(JSON.stringify(record));
    this.scheduleFlush();
  }

  /** Force immediate flush (call before process exit) */
  async close(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    await this.flush();
  }
}

/** Composite audit sink — delegates to multiple sinks */
export class CompositeAuditSink implements AuditSink {
  constructor(private readonly sinks: AuditSink[]) {}

  async onCallStart(record: AuditRecord): Promise<void> {
    await Promise.all(this.sinks.map((s) => s.onCallStart(record)));
  }

  async onCallSuccess(record: AuditRecord): Promise<void> {
    await Promise.all(this.sinks.map((s) => s.onCallSuccess(record)));
  }

  async onCallFailure(record: AuditRecord): Promise<void> {
    await Promise.all(this.sinks.map((s) => s.onCallFailure(record)));
  }
}
