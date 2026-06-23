import {
  SCHEMA_VERSION,
  createId,
  nowTimestamp,
  type AgentId,
  type RiskLevel,
  type SchemaVersion,
  type TaskBudget,
  type TaskCreateRequest,
  type TaskId,
  type Timestamp,
} from '../core';
import {
  InMemoryMailboxStore,
  type MessageDelivery,
  type SendMessageInput,
  type SendMessageResult,
} from './mailbox-store';
import { transitionTaskStatus, type CoordinatorTaskStatus } from './task-state-machine';
import type { MessageId, MessageRecipient, RoleId } from '../core';
import {
  createCoordinatorCheckpoint,
  InMemoryCheckpointStore,
  type CoordinatorCheckpoint,
  type CoordinatorCheckpointForkResult,
  type CoordinatorCheckpointHistoryOptions,
  type CoordinatorCheckpointMeta,
  type CoordinatorCheckpointRequest,
} from './checkpoint-store';
import type { CheckpointId, ThreadId } from '../core';

export interface CoordinatorRetryPolicy {
  max_retries: number;
  backoff: 'none' | 'fixed' | 'exponential';
}

export interface CoordinatorTaskCreateRequest extends TaskCreateRequest {
  role_profile_ref?: string;
  retry_policy?: CoordinatorRetryPolicy;
  schema_version?: SchemaVersion;
}

export interface CoordinatorTask {
  task_id: TaskId;
  parent_id?: TaskId;
  status: CoordinatorTaskStatus;
  owner_agent_id?: AgentId;
  role_id?: RoleId;
  role_profile_ref?: string;
  risk_level: RiskLevel;
  spec: string;
  completion_criteria: string[];
  affected_paths?: string[];
  budget?: TaskBudget;
  retry_policy?: CoordinatorRetryPolicy;
  created_at: Timestamp;
  updated_at: Timestamp;
  schema_version: SchemaVersion;
}

export interface InMemoryCoordinatorFacadeStores {
  mailbox: InMemoryMailboxStore;
  checkpoints: InMemoryCheckpointStore<CoordinatorCheckpoint>;
}

export class InMemoryCoordinatorFacade {
  readonly stores: InMemoryCoordinatorFacadeStores;
  private readonly tasks = new Map<TaskId, CoordinatorTask>();

  constructor(stores?: Partial<InMemoryCoordinatorFacadeStores>) {
    this.stores = {
      mailbox: stores?.mailbox ?? new InMemoryMailboxStore(),
      checkpoints: stores?.checkpoints ?? new InMemoryCheckpointStore<CoordinatorCheckpoint>(),
    };
  }

  createTask(request: CoordinatorTaskCreateRequest): CoordinatorTask {
    const timestamp = nowTimestamp();
    const task: CoordinatorTask = {
      task_id: createId('task'),
      ...(request.parent_task_id ? { parent_id: request.parent_task_id } : {}),
      status: 'created',
      ...(request.role_id ? { role_id: request.role_id } : {}),
      ...(request.role_profile_ref ? { role_profile_ref: request.role_profile_ref } : {}),
      risk_level: request.risk_level ?? 'low',
      spec: request.spec,
      completion_criteria: request.completion_criteria,
      ...(request.affected_paths ? { affected_paths: request.affected_paths } : {}),
      ...(request.budget ? { budget: request.budget } : {}),
      ...(request.retry_policy ? { retry_policy: request.retry_policy } : {}),
      created_at: timestamp,
      updated_at: timestamp,
      schema_version: SCHEMA_VERSION,
    };

    this.tasks.set(task.task_id, task);
    return task;
  }

  claimTask(taskId: TaskId, agentId: AgentId): CoordinatorTask {
    const task = this.getExistingTask(taskId);
    if (task.status === 'claimed' && task.owner_agent_id === agentId) {
      return task;
    }
    if (task.status === 'claimed' && task.owner_agent_id !== agentId) {
      throw new Error(`Task ${taskId} is already claimed by ${task.owner_agent_id}`);
    }

    transitionTaskStatus(task.status, 'claimed');

    return this.saveTask({
      ...task,
      status: 'claimed',
      owner_agent_id: agentId,
      updated_at: nowTimestamp(),
    });
  }

  updateTaskStatus(
    taskId: TaskId,
    status: CoordinatorTaskStatus,
    _reason?: string,
  ): CoordinatorTask {
    const task = this.getExistingTask(taskId);
    const transition = transitionTaskStatus(task.status, status);

    return this.saveTask({
      ...task,
      status: transition.next_status,
      updated_at: nowTimestamp(),
    });
  }

  sendMessage(input: SendMessageInput): SendMessageResult {
    return this.stores.mailbox.send(input);
  }

  ackMessage(messageId: MessageId, recipient: MessageRecipient): MessageDelivery {
    return this.stores.mailbox.ack(messageId, recipient);
  }

  saveCheckpoint(request: CoordinatorCheckpointRequest): CoordinatorCheckpoint {
    this.getExistingTask(request.task_id);
    const checkpoint = createCoordinatorCheckpoint(request);
    return this.stores.checkpoints.save(checkpoint);
  }

  loadCheckpoint(
    threadId: ThreadId,
    checkpointId?: CheckpointId,
  ): CoordinatorCheckpoint | undefined {
    return this.stores.checkpoints.load(threadId, checkpointId);
  }

  listCheckpointHistory(
    threadId: ThreadId,
    options?: CoordinatorCheckpointHistoryOptions,
  ): CoordinatorCheckpointMeta[] {
    return this.stores.checkpoints.listHistory(threadId, options).map((checkpoint) => ({
      checkpoint_id: checkpoint.checkpoint_id,
      parent_checkpoint_id: checkpoint.parent_checkpoint_id ?? null,
      checkpoint_type: checkpoint.checkpoint_type,
      schema_version: checkpoint.schema_version,
      timestamp: checkpoint.created_at,
      trigger: checkpoint.trigger,
      message_count: checkpoint.message_thread.length,
      turn_count: checkpoint.scheduling.current_turn,
    }));
  }

  forkCheckpoint(
    threadId: ThreadId,
    checkpointId: CheckpointId,
    newThreadId: ThreadId,
  ): CoordinatorCheckpointForkResult {
    return this.stores.checkpoints.fork(threadId, checkpointId, newThreadId);
  }

  private getExistingTask(taskId: TaskId): CoordinatorTask {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} was not found`);
    }

    return task;
  }

  private saveTask(task: CoordinatorTask): CoordinatorTask {
    this.tasks.set(task.task_id, task);
    return task;
  }
}
