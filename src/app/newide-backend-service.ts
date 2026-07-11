/**
 * 前端 RPC 的 application service。
 *
 * 这个文件负责异步启动 integration runner 并维护查询状态，不处理 JSON-RPC framing 或进程 I/O。
 */
import type { IntegrationV0Result } from '../coordinator/integration-v0-flow';
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
  ) {}

  createRun(params: RunCreateParams): Promise<RunCreateResult> {
    const mode = params.mode ?? 'single_agent';
    return new Promise<RunCreateResult>((resolve, reject) => {
      let identity: { run_id: string; task_id: string } | undefined;
      const pendingTelemetry: TelemetryRecord[] = [];
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
          onRunCreated: (created) => {
            if (identity) return;
            identity = created;
            this.registry.create({ ...created, mode });
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
        .then((result) => {
          if (!identity) {
            reject(new Error('Integration runner completed without reporting run identity'));
            return;
          }
          if (result.summary.status === 'completed') {
            this.registry.complete(identity.run_id, result.frontend_snapshot);
          } else {
            this.registry.fail(identity.run_id, 'FLOW_FAILED', 'Integration flow failed');
          }
        })
        .catch((error: unknown) => {
          const normalized = toError(error);
          if (!identity) {
            reject(normalized);
            return;
          }
          this.registry.fail(identity.run_id, 'RUNNER_FAILED', normalized.message);
        });
    });
  }

  getSnapshot(runId: string): AppRunSnapshot {
    return this.registry.getSnapshot(runId);
  }

  subscribe(runId: string, listener: (event: AppRunEvent) => void): () => void {
    return this.registry.subscribe(runId, listener);
  }

  private appendTelemetry(
    identity: { run_id: string; task_id: string },
    record: TelemetryRecord,
  ): void {
    if (record.run_id && record.run_id !== identity.run_id) return;
    if (record.task_id && record.task_id !== identity.task_id) return;
    this.registry.appendEvent(identity.run_id, record.event_type, record.payload);
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
