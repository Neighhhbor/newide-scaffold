/**
 * 前端 RPC 的 application service。
 *
 * 这个文件负责异步启动 integration runner 并维护查询状态，不处理 JSON-RPC framing 或进程 I/O。
 */
import type { IntegrationV0Result } from '../coordinator/integration-v0-flow';
import type { Event } from '../core';
import {
  IntegrationV0CoordinatorRunner,
  type CoordinatorRunner,
} from '../coordinator/coordinator-runner';
import type { TelemetryRecord, TelemetrySink } from '../telemetry/telemetry-sink';
import {
  InMemoryRunRegistry,
  type AppRunEvent,
  type AppRunMode,
  type AppRunSnapshot,
} from './run-registry';
import { FileRunAuditWriter, type RunAuditWriter } from './run-audit-writer';
import {
  FileRunTerminalOutputWriter,
  type RunTerminalOutputWriter,
} from './run-terminal-output-writer';
import { projectRunSnapshot } from './run-snapshot-projector';
import type { RunSnapshot } from '../protocol/run-snapshot';

export interface RunCreateParams {
  prompt: string;
  mode?: AppRunMode;
  project_id?: string;
  client_task_id?: string;
  title?: string;
}

export interface RunCreateResult {
  run_id: string;
  task_id: string;
  status: 'running';
}

export class NewideBackendService {
  constructor(
    private readonly runner: CoordinatorRunner = new IntegrationV0CoordinatorRunner(),
    private readonly registry = new InMemoryRunRegistry(),
    private readonly auditWriter: RunAuditWriter = new FileRunAuditWriter(),
    private readonly terminalWriter: RunTerminalOutputWriter = new FileRunTerminalOutputWriter(),
  ) {}

  createRun(params: RunCreateParams): Promise<RunCreateResult> {
    const mode = params.mode ?? 'single_agent';
    const controller = new AbortController();
    return new Promise<RunCreateResult>((resolve, reject) => {
      let identity: { run_id: string; task_id: string } | undefined;
      const pendingTelemetry: TelemetryRecord[] = [];
      const pendingEvents: Event[] = [];
      const telemetry: TelemetrySink = {
        emit: (record) => {
          if (!identity) {
            pendingTelemetry.push(record);
            return;
          }
          this.appendTelemetry(identity, record);
        },
      };

      let runnerPromise: Promise<IntegrationV0Result>;
      try {
        runnerPromise = this.runner.run({
          prompt: params.prompt,
          mode,
          telemetry,
          signal: controller.signal,
          onEvent: (event) => {
            if (!identity) {
              pendingEvents.push(event);
              return;
            }
            this.appendDomainEvent(identity, event);
          },
          onRunCreated: (created) => {
            if (identity) return;
            identity = created;
            this.registry.create({ ...created, mode, controller });
            this.registry.subscribe(created.run_id, (event) => {
              void this.auditWriter.append(event);
            });
            for (const event of pendingEvents) this.appendDomainEvent(created, event);
            this.registry.appendEvent(created.run_id, 'run.started', { mode });
            for (const record of pendingTelemetry) this.appendTelemetry(created, record);
            resolve({ ...created, status: 'running' });
          },
        });
      } catch (error) {
        reject(toError(error));
        return;
      }

      void runnerPromise
        .then(async (result) => {
          if (!identity) {
            reject(new Error('Integration runner completed without reporting run identity'));
            return;
          }
          if (result.summary.status === 'completed') {
            this.registry.complete(identity.run_id, result.frontend_snapshot);
          } else {
            this.registry.fail(identity.run_id, 'FLOW_FAILED', 'Integration flow failed');
          }
          await this.auditWriter.flush(identity.run_id);
          await this.terminalWriter.finalize(this.registry.getSnapshot(identity.run_id));
        })
        .catch(async (error: unknown) => {
          const normalized = toError(error);
          if (!identity) {
            reject(normalized);
            return;
          }
          this.registry.fail(identity.run_id, 'RUNNER_FAILED', normalized.message);
          await this.auditWriter.flush(identity.run_id);
          await this.terminalWriter.finalize(this.registry.getSnapshot(identity.run_id));
        });
    });
  }

  getSnapshot(runId: string): AppRunSnapshot {
    return this.registry.getSnapshot(runId);
  }

  getRunSnapshot(runId: string): RunSnapshot {
    return projectRunSnapshot(this.registry.getSnapshot(runId));
  }

  async cancelRun(runId: string): Promise<{ cancelled: true }> {
    this.registry.cancel(runId);
    await this.auditWriter.flush(runId);
    await this.terminalWriter.finalize(this.registry.getSnapshot(runId));
    return { cancelled: true };
  }

  subscribe(runId: string, listener: (event: AppRunEvent) => void): () => void {
    return this.registry.subscribe(runId, listener);
  }

  private appendTelemetry(
    identity: { run_id: string; task_id: string },
    record: TelemetryRecord,
  ): void {
    if (record.source?.kind === 'event_store') return;
    if (record.run_id && record.run_id !== identity.run_id) return;
    if (record.task_id && record.task_id !== identity.task_id) return;
    this.registry.appendEvent(identity.run_id, record.event_type, record.payload);
  }

  private appendDomainEvent(identity: { run_id: string; task_id: string }, event: Event): void {
    if (event.run_id && event.run_id !== identity.run_id) return;
    if (event.task_id && event.task_id !== identity.task_id) return;
    this.registry.appendEvent(identity.run_id, event.event_type, event.payload, {
      event_id: event.event_id,
      created_at: event.created_at,
    });
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
