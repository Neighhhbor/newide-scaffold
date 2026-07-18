/**
 * Coordinator 对外运行入口。
 *
 * 这个文件定义稳定 Runner contract，并把 integration-v0 作为当前实现适配进去。
 * 它不处理 JSON-RPC、进程流或 run registry。
 */
import {
  runIntegrationV0Flow,
  type IntegrationV0Options,
  type IntegrationV0Result,
} from './integration-v0-flow';
import type { TelemetrySink } from '../telemetry/telemetry-sink';
import type { Event, TaskCreateRequest } from '../core';

export interface CoordinatorRunRequest {
  prompt: string;
  mode: 'single_agent' | 'council';
  workspace_path: string;
  session_id?: string;
  task_request?: TaskCreateRequest;
  telemetry?: TelemetrySink;
  signal?: AbortSignal;
  onEvent?: (event: Event) => void;
  onRunCreated?: (identity: { run_id: string; task_id: string }) => void;
}

export interface CoordinatorRunner {
  run(request: CoordinatorRunRequest): Promise<IntegrationV0Result>;
}

export type IntegrationFlow = (options: IntegrationV0Options) => Promise<IntegrationV0Result>;

type RunnerDefaults = Omit<
  IntegrationV0Options,
  | 'driverPrompt'
  | 'enableCouncil'
  | 'taskRequest'
  | 'telemetry'
  | 'signal'
  | 'onEvent'
  | 'onRunCreated'
>;

export class IntegrationV0CoordinatorRunner implements CoordinatorRunner {
  constructor(
    private readonly defaults: RunnerDefaults = {},
    private readonly flow: IntegrationFlow = runIntegrationV0Flow,
  ) {}

  run(request: CoordinatorRunRequest): Promise<IntegrationV0Result> {
    return this.flow({
      ...this.defaults,
      driverPrompt: request.prompt,
      enableCouncil: request.mode === 'council',
      workspacePath: request.workspace_path,
      ...(request.session_id ? { sessionId: request.session_id } : {}),
      ...(request.task_request ? { taskRequest: request.task_request } : {}),
      ...(request.telemetry ? { telemetry: request.telemetry } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.onEvent ? { onEvent: request.onEvent } : {}),
      ...(request.onRunCreated ? { onRunCreated: request.onRunCreated } : {}),
    });
  }
}
