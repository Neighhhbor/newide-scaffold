/**
 * ================================================
 * Audit Interface
 * ================================================
 * Call lifecycle auditing: start, success, failure.
 */

import type { AuditSink, AuditRecord, LiteLLMTaskType, TokenUsage } from './types';

/** Generates unique call IDs */
let callIdCounter = 0;
function generateCallId(): string {
  return `call_${Date.now()}_${++callIdCounter}_${Math.random().toString(36).slice(2, 6)}`;
}

/** Audit controller — manages call lifecycle events */
export class AuditController {
  private sinks: AuditSink[] = [];

  /** Register an audit sink */
  addSink(sink: AuditSink): void {
    this.sinks.push(sink);
  }

  /** Register multiple sinks */
  addSinks(sinks: AuditSink[]): void {
    this.sinks.push(...sinks);
  }

  /** Create a new audit record for an in-flight call */
  startRecord(
    task: LiteLLMTaskType,
    model: string,
    messageCount: number,
    toolNames: string[],
    metadata?: Record<string, unknown>,
  ): {
    callId: string;
    end: (result: { usage?: TokenUsage; error?: AuditRecord['error'] }) => Promise<void>;
  } {
    const callId = generateCallId();
    const startTime = new Date();

    const record: AuditRecord = {
      callId,
      task,
      model,
      startTime,
      messageCount,
      toolNames,
      status: 'started',
      metadata,
    };

    // Notify all sinks (fire-and-forget for start)
    for (const sink of this.sinks) {
      try {
        const result = sink.onCallStart(record);
        if (result instanceof Promise) {
          result.catch((e) => console.error('[Audit] onCallStart failed:', e));
        }
      } catch (e) {
        console.error('[Audit] onCallStart failed:', e);
      }
    }

    // Return end callback
    const end = async (result: {
      usage?: TokenUsage;
      error?: AuditRecord['error'];
    }): Promise<void> => {
      const endTime = new Date();
      const durationMs = endTime.getTime() - startTime.getTime();

      const finalRecord: AuditRecord = {
        ...record,
        endTime,
        durationMs,
        usage: result.usage,
        error: result.error,
        status: result.error ? 'failed' : 'success',
      };

      const method = result.error ? 'onCallFailure' : 'onCallSuccess';
      for (const sink of this.sinks) {
        try {
          const r = sink[method](finalRecord);
          if (r instanceof Promise) {
            await r;
          }
        } catch (e) {
          console.error(`[Audit] ${method} failed:`, e);
        }
      }
    };

    return { callId, end };
  }

  /** Clear all sinks */
  clear(): void {
    this.sinks = [];
  }
}

export type { AuditSink, AuditRecord };
