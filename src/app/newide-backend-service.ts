/**
 * 前端 RPC 的 application service。
 *
 * 这个文件负责异步启动 integration runner 并维护查询状态，不处理 JSON-RPC framing 或进程 I/O。
 */
import type { IntegrationV0Result } from '../coordinator/integration-v0-flow';
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { CouncilRoleExecutionError } from '../council';
import type { Event } from '../core';
import {
  IntegrationV0CoordinatorRunner,
  type CoordinatorRunner,
} from '../coordinator/coordinator-runner';
import { createDefaultTaskRequest } from '../coordinator/task-request';
import type { TaskCreateRequest } from '../core';
import type { TelemetryRecord, TelemetrySink } from '../telemetry/telemetry-sink';
import {
  InMemoryRunRegistry,
  type AppRunEvent,
  type AppRunMode,
  type AppRunSnapshot,
  type StagedTerminalTransition,
} from './run-registry';
import { FileRunAuditWriter, type RunAuditWriter } from './run-audit-writer';
import {
  FileRunTerminalOutputWriter,
  type RunTerminalOutputWriter,
} from './run-terminal-output-writer';
import {
  FileRunRequestStore,
  type RunHistoryEntry,
  type RunRequestStore,
} from './run-request-store';
import { projectRunSnapshot } from './run-snapshot-projector';
import type { RunSnapshot } from '../protocol/run-snapshot';

export interface RunCreateParams {
  prompt: string;
  workspace_path?: string;
  session_id?: string;
  task_request?: TaskCreateRequest;
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

export interface RunListResult {
  runs: RunHistoryEntry[];
}

export interface RunRestartResult {
  run_id: string;
  task_id: string;
  restarted_from_run_id: string;
  status: 'running';
}

export class NewideBackendService {
  private readonly terminalRuns = new Map<string, Promise<void>>();

  constructor(
    private readonly runner: CoordinatorRunner = new IntegrationV0CoordinatorRunner(),
    private readonly registry = new InMemoryRunRegistry(),
    private readonly auditWriter: RunAuditWriter = new FileRunAuditWriter(),
    private readonly terminalWriter: RunTerminalOutputWriter = new FileRunTerminalOutputWriter(),
    private readonly requestStore: RunRequestStore = new FileRunRequestStore(),
  ) {}

  createRun(params: RunCreateParams): Promise<RunCreateResult> {
    return this.startRun(params);
  }

  async listRuns(): Promise<RunListResult> {
    const history = await this.requestStore.listHistory();
    return {
      // 仍在本进程运行中的 run 由 run.getSnapshot 提供真实状态；
      // 历史列表只回放已经落盘的 run，绝不把遗留目录伪装成 running。
      runs: history.filter((entry) => !this.isLiveRun(entry.run_id)),
    };
  }

  async restartRun(runId: string): Promise<RunRestartResult> {
    // restart 是"从持久化边界重新执行"：只恢复 request.json 里的输入，
    // 创建全新 run_id，不复活旧进程，也不声称恢复 Agent 内部状态。
    const request = await this.requestStore.load(runId);
    // 终态快照里的 session_id 是 Driver 真实会话；存在则复用，
    // 否则退回创建时显式携带的 session。
    const terminalSessionId = await this.requestStore
      .readTerminalSessionId(runId)
      .catch(() => undefined);
    const sessionId = terminalSessionId ?? request.session_id;
    const created = await this.startRun(
      {
        prompt: request.prompt,
        workspace_path: request.workspace_path,
        mode: request.mode,
        ...(sessionId ? { session_id: sessionId } : {}),
        ...(request.task_request ? { task_request: request.task_request } : {}),
        ...(request.project_id ? { project_id: request.project_id } : {}),
        ...(request.client_task_id ? { client_task_id: request.client_task_id } : {}),
        ...(request.title ? { title: request.title } : {}),
      },
      { restarted_from_run_id: runId },
    );
    return { ...created, restarted_from_run_id: runId };
  }

  private startRun(
    params: RunCreateParams,
    lineage?: { restarted_from_run_id: string },
  ): Promise<RunCreateResult> {
    const mode = params.mode ?? 'single_agent';
    const workspacePath = normalizeWorkspacePath(params.workspace_path ?? process.cwd());
    const taskRequest = params.task_request ?? createDefaultTaskRequest(params.prompt);
    const controller = new AbortController();
    return new Promise<RunCreateResult>((resolve, reject) => {
      let resolveTerminal!: () => void;
      const terminalRun = new Promise<void>((resolveRun) => {
        resolveTerminal = resolveRun;
      });
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
          workspace_path: workspacePath,
          ...(params.session_id ? { session_id: params.session_id } : {}),
          task_request: taskRequest,
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
            this.terminalRuns.set(created.run_id, terminalRun);
            this.registry.create({ ...created, mode, controller });
            this.registry.subscribe(created.run_id, (event) => {
              void this.auditWriter.append(event).catch(() => undefined);
            });
            for (const event of pendingEvents) this.appendDomainEvent(created, event);
            this.registry.appendEvent(created.run_id, 'run.started', { mode });
            for (const record of pendingTelemetry) this.appendTelemetry(created, record);
            void this.requestStore
              .save({
                run_id: created.run_id,
                task_id: created.task_id,
                prompt: params.prompt,
                workspace_path: workspacePath,
                mode,
                task_request: taskRequest,
                ...(params.session_id ? { session_id: params.session_id } : {}),
                ...(params.project_id ? { project_id: params.project_id } : {}),
                ...(params.client_task_id ? { client_task_id: params.client_task_id } : {}),
                ...(params.title ? { title: params.title } : {}),
                ...(lineage ? { restarted_from_run_id: lineage.restarted_from_run_id } : {}),
              })
              .catch(() => undefined);
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
            const staged = this.registry.stageTerminal(identity.run_id, {
              status: 'completed',
              snapshot: result.frontend_snapshot,
            });
            if (staged) await this.persistTerminal(identity.run_id, staged);
          } else {
            const failure = result.summary.failure;
            const staged = this.registry.stageTerminal(identity.run_id, {
              status: 'failed',
              code: failure?.code ?? 'FLOW_FAILED',
              message: failure?.message ?? 'Integration flow failed',
              ...(failure?.details ? { details: failure.details } : {}),
              snapshot: result.frontend_snapshot,
            });
            if (staged) await this.persistTerminal(identity.run_id, staged);
          }
        })
        .catch(async (error: unknown) => {
          const normalized = toError(error);
          if (!identity) {
            reject(normalized);
            return;
          }
          const staged = this.registry.stageTerminal(identity.run_id, {
            status: 'failed',
            code: error instanceof CouncilRoleExecutionError ? error.code : 'RUNNER_FAILED',
            message: normalized.message,
            ...(error instanceof CouncilRoleExecutionError ? { details: error.details } : {}),
          });
          if (staged) await this.persistTerminal(identity.run_id, staged);
        })
        .then(resolveTerminal, resolveTerminal);
      void terminalRun.then(() => this.terminalRuns.delete(identity?.run_id ?? ''));
    });
  }

  getSnapshot(runId: string): AppRunSnapshot {
    return this.registry.getSnapshot(runId);
  }

  getRunSnapshot(runId: string): RunSnapshot {
    return projectRunSnapshot(this.registry.getSnapshot(runId));
  }

  async waitForTerminal(runId: string): Promise<void> {
    const before = this.registry.getSnapshot(runId);
    await this.terminalRuns.get(runId);
    const snapshot = this.registry.getSnapshot(runId);
    if (snapshot.status === 'failed' && snapshot.error?.code === 'TERMINAL_OUTPUT_FAILED') {
      throw new Error(snapshot.error.message);
    }
    if (before.status === 'running' && snapshot.status === 'running') {
      throw new Error(`Run ${runId} did not reach a terminal state`);
    }
  }

  async cancelRun(runId: string): Promise<{ cancelled: true }> {
    const staged = this.registry.stageTerminal(runId, { status: 'cancelled' });
    if (staged) await this.persistTerminal(runId, staged);
    else await this.waitForTerminal(runId);
    const snapshot = this.registry.getSnapshot(runId);
    if (snapshot.status !== 'cancelled') {
      throw new Error(snapshot.error?.message ?? `Run ${runId} already reached ${snapshot.status}`);
    }
    return { cancelled: true };
  }

  subscribe(runId: string, listener: (event: AppRunEvent) => void): () => void {
    return this.registry.subscribe(runId, listener);
  }

  private isLiveRun(runId: string): boolean {
    return this.terminalRuns.has(runId);
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
    if (event.event_type === 'run.completed' || event.event_type === 'run.failed') return;
    if (event.run_id && event.run_id !== identity.run_id) return;
    if (event.task_id && event.task_id !== identity.task_id) return;
    this.registry.appendEvent(identity.run_id, event.event_type, event.payload, {
      event_id: event.event_id,
      created_at: event.created_at,
    });
  }

  private async persistTerminal(runId: string, staged: StagedTerminalTransition): Promise<void> {
    try {
      await this.auditWriter.flush(runId);
      await this.terminalWriter.finalize(staged.snapshot);
      this.registry.commitTerminal(runId, staged);
      await this.auditWriter.flush(runId).catch(() => undefined);
    } catch (error) {
      this.registry.abortTerminal(runId, staged.token);
      const failure = this.registry.stageTerminal(runId, {
        status: 'failed',
        code: 'TERMINAL_OUTPUT_FAILED',
        message: toError(error).message,
      });
      if (!failure) return;
      this.registry.commitTerminal(runId, failure);
    }
  }
}

function normalizeWorkspacePath(input: string): string {
  if (!path.isAbsolute(input)) {
    throw new Error('workspace_path must be an absolute directory');
  }
  try {
    const workspacePath = realpathSync(input);
    if (!statSync(workspacePath).isDirectory()) {
      throw new Error('not a directory');
    }
    return workspacePath;
  } catch {
    throw new Error(`workspace_path must be an existing directory: ${input}`);
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
