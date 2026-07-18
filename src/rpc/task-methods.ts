/**
 * task.* JSON-RPC 方法适配器。
 *
 * 这里只校验外部参数并映射 application service 错误，不维护 Task 或 Run 状态。
 */
import path from 'node:path';
import { z } from 'zod';
import {
  TaskAlreadyRunningError,
  TaskNotFoundError,
  TaskNotRunningError,
  type TaskCreateParams,
  type TaskListResult,
} from '../app/newide-backend-service';
import type { TaskSnapshot } from '../protocol/task-snapshot';
import { JsonRpcMethodError, type JsonRpcDispatcher } from './json-rpc-dispatcher';
import { JSON_RPC_ERROR_CODES } from './json-rpc-line-protocol';

export interface TaskMethodsService {
  createTask(params: TaskCreateParams): Promise<TaskSnapshot>;
  getTask(taskId: string): Promise<TaskSnapshot>;
  listTasks(): Promise<TaskListResult>;
  cancelTask(taskId: string): Promise<TaskSnapshot>;
  startCouncil(taskId: string): Promise<TaskSnapshot>;
}

const budgetSchema = z
  .object({
    max_tokens: z.number().int().positive().optional(),
    max_wall_clock_seconds: z.number().int().positive().optional(),
    max_tool_calls: z.number().int().positive().optional(),
  })
  .strict();

const createParamsSchema = z
  .object({
    spec: z.string().trim().min(1),
    role_id: z.string().trim().min(1).optional(),
    parent_task_id: z.string().trim().min(1).optional(),
    deps: z.array(z.string().trim().min(1)).optional(),
    risk_level: z.enum(['low', 'medium', 'high', 'critical']).optional(),
    affected_paths: z.array(z.string()).optional(),
    completion_criteria: z.array(z.string().trim().min(1)).min(1),
    budget: budgetSchema.optional(),
    workspace_path: z.string().trim().min(1).refine(path.isAbsolute),
    session_id: z.string().trim().min(1).optional(),
    mode: z.enum(['single_agent', 'council']).optional(),
    project_id: z.string().min(1).optional(),
    client_task_id: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
  })
  .strict();

const taskIdParamsSchema = z.object({ task_id: z.string().trim().min(1) }).strict();
const emptyParamsSchema = z.object({}).strict();

export class TaskRpcMethods {
  constructor(private readonly service: TaskMethodsService) {}

  register(dispatcher: JsonRpcDispatcher): void {
    dispatcher.register('task.create', (params) => {
      const parsed = parseParams(createParamsSchema, params);
      return this.callWithTaskError(() => this.service.createTask(compactCreateParams(parsed)));
    });
    dispatcher.register('task.get', (params) => {
      const { task_id } = parseParams(taskIdParamsSchema, params);
      return this.callWithTaskError(() => this.service.getTask(task_id));
    });
    dispatcher.register('task.list', (params) => {
      parseParams(emptyParamsSchema, params ?? {});
      return this.service.listTasks();
    });
    dispatcher.register('task.cancel', (params) => {
      const { task_id } = parseParams(taskIdParamsSchema, params);
      return this.callWithTaskError(() => this.service.cancelTask(task_id));
    });
    dispatcher.register('task.startCouncil', (params) => {
      const { task_id } = parseParams(taskIdParamsSchema, params);
      return this.callWithTaskError(() => this.service.startCouncil(task_id));
    });
  }

  private async callWithTaskError<T>(operation: () => T | Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof TaskNotFoundError) {
        throw new JsonRpcMethodError(JSON_RPC_ERROR_CODES.TASK_NOT_FOUND, 'Task not found', {
          task_id: error.taskId,
        });
      }
      if (error instanceof TaskAlreadyRunningError) {
        throw new JsonRpcMethodError(
          JSON_RPC_ERROR_CODES.TASK_ALREADY_RUNNING,
          'Task already running',
          { task_id: error.taskId },
        );
      }
      if (error instanceof TaskNotRunningError) {
        throw new JsonRpcMethodError(JSON_RPC_ERROR_CODES.TASK_NOT_RUNNING, 'Task not running', {
          task_id: error.taskId,
        });
      }
      throw error;
    }
  }
}

function parseParams<T>(schema: z.ZodType<T>, params: unknown): T {
  const parsed = schema.safeParse(params);
  if (!parsed.success) {
    throw new JsonRpcMethodError(JSON_RPC_ERROR_CODES.INVALID_PARAMS, 'Invalid params');
  }
  return parsed.data;
}

function compactCreateParams(input: z.infer<typeof createParamsSchema>): TaskCreateParams {
  return {
    spec: input.spec,
    ...(input.role_id ? { role_id: input.role_id } : {}),
    ...(input.parent_task_id ? { parent_task_id: input.parent_task_id } : {}),
    ...(input.deps ? { deps: [...input.deps] } : {}),
    ...(input.risk_level ? { risk_level: input.risk_level } : {}),
    ...(input.affected_paths ? { affected_paths: [...input.affected_paths] } : {}),
    completion_criteria: [...input.completion_criteria],
    ...(input.budget
      ? {
          budget: {
            ...(input.budget.max_tokens !== undefined
              ? { max_tokens: input.budget.max_tokens }
              : {}),
            ...(input.budget.max_wall_clock_seconds !== undefined
              ? { max_wall_clock_seconds: input.budget.max_wall_clock_seconds }
              : {}),
            ...(input.budget.max_tool_calls !== undefined
              ? { max_tool_calls: input.budget.max_tool_calls }
              : {}),
          },
        }
      : {}),
    workspace_path: input.workspace_path,
    ...(input.session_id ? { session_id: input.session_id } : {}),
    ...(input.mode ? { mode: input.mode } : {}),
    ...(input.project_id ? { project_id: input.project_id } : {}),
    ...(input.client_task_id ? { client_task_id: input.client_task_id } : {}),
    ...(input.title ? { title: input.title } : {}),
  };
}
