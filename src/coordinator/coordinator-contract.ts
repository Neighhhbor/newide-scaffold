/**
 * Coordinator contract-facing API.
 *
 * - 外部模块面对的是 `_coord.task.*`、`_coord.message.*`、`_coord.state.*` 形状。
 * - 内部实现使用 TypeScript 风格方法名，如 `createTask` / `sendMessage`。
 * - `createCoordinatorContract` 是中间 adapter，负责把内部 facade 映射成 public API。
 *
 * 当前仍是 MinimalCoordinatorContract：
 * - 已覆盖 task create/claim/update_status、message send/ack、state checkpoint/load/list_history/fork placeholder。
 * - 尚未覆盖 task.escalate、message.timeout、artifact、gate result、完整 resume、Council public API。
 */
import type { AgentId, CheckpointId, MessageId, MessageRecipient, TaskId, ThreadId } from '../core';
import { InMemoryCoordinatorFacade } from './coordinator-facade';
import type { CoordinatorTask, CoordinatorTaskCreateRequest } from './coordinator-facade';
import type { MessageDelivery, SendMessageInput, SendMessageResult } from './mailbox-store';
import type { CoordinatorTaskStatus } from './task-state-machine';
import type {
  CoordinatorCheckpoint,
  CoordinatorCheckpointForkResult,
  CoordinatorCheckpointHistoryOptions,
  CoordinatorCheckpointMeta,
  CoordinatorCheckpointRequest,
} from './checkpoint-store';

export interface CoordinatorFacadeLike {
  createTask(request: CoordinatorTaskCreateRequest): CoordinatorTask;
  claimTask(taskId: TaskId, agentId: AgentId): CoordinatorTask;
  updateTaskStatus(taskId: TaskId, status: CoordinatorTaskStatus, reason?: string): CoordinatorTask;
  sendMessage(input: SendMessageInput): SendMessageResult;
  ackMessage(messageId: MessageId, recipient: MessageRecipient): MessageDelivery;
  saveCheckpoint(request: CoordinatorCheckpointRequest): CoordinatorCheckpoint;
  loadCheckpoint(
    threadId: ThreadId,
    checkpointId?: CheckpointId,
  ): CoordinatorCheckpoint | undefined;
  listCheckpointHistory(
    threadId: ThreadId,
    options?: CoordinatorCheckpointHistoryOptions,
  ): CoordinatorCheckpointMeta[];
  forkCheckpoint(
    threadId: ThreadId,
    checkpointId: CheckpointId,
    newThreadId: ThreadId,
  ): CoordinatorCheckpointForkResult;
}

/**
 * MVP 阶段的对外契约形状。
 *
 * 这里故意不命名为完整 CoordinatorContract，避免误导调用方认为所有
 * public APIs 都已实现。后续补齐 artifact/gate/council/resume 后再扩展。
 */
export interface MinimalCoordinatorContract {
  task: {
    create(request: CoordinatorTaskCreateRequest): CoordinatorTask;
    claim(taskId: TaskId, agentId: AgentId): CoordinatorTask;
    update_status(taskId: TaskId, status: CoordinatorTaskStatus, reason?: string): CoordinatorTask;
  };
  message: {
    send(input: SendMessageInput): SendMessageResult;
    ack(messageId: MessageId, recipient: MessageRecipient): void;
  };
  state: {
    /**
     * 保存协调边界状态：message_thread、scheduling、SE 状态、mechanical_snapshot、
     * semantic_handoff、artifact_refs、interrupt_state。
     */
    checkpoint(request: CoordinatorCheckpointRequest): CoordinatorCheckpoint;
    /** 加载指定 thread 的最新 checkpoint，或按 checkpoint_id 加载该 thread 下的指定 checkpoint。 */
    load(threadId: ThreadId, checkpointId?: CheckpointId): CoordinatorCheckpoint | undefined;
    /** 返回指定 thread 的 checkpoint 历史元数据，用于审计/展示，不返回完整 payload。 */
    list_history(
      threadId: ThreadId,
      options?: CoordinatorCheckpointHistoryOptions,
    ): CoordinatorCheckpointMeta[];
    /** checkpoint fork 边界；MVP 只保留显式 not implemented 占位。 */
    fork(
      threadId: ThreadId,
      checkpointId: CheckpointId,
      newThreadId: ThreadId,
    ): CoordinatorCheckpointForkResult;
  };
}

export function createCoordinatorContract(
  facade: CoordinatorFacadeLike,
): MinimalCoordinatorContract {
  return {
    task: {
      create: (request) => facade.createTask(request),
      claim: (taskId, agentId) => facade.claimTask(taskId, agentId),
      update_status: (taskId, status, reason) => facade.updateTaskStatus(taskId, status, reason),
    },
    message: {
      send: (input) => facade.sendMessage(input),
      ack: (messageId, recipient) => {
        facade.ackMessage(messageId, recipient);
      },
    },
    state: {
      checkpoint: (request) => facade.saveCheckpoint(request),
      load: (threadId, checkpointId) => facade.loadCheckpoint(threadId, checkpointId),
      list_history: (threadId, options) => facade.listCheckpointHistory(threadId, options),
      fork: (threadId, checkpointId, newThreadId) =>
        facade.forkCheckpoint(threadId, checkpointId, newThreadId),
    },
  };
}

export function createInMemoryCoordinatorContract(): MinimalCoordinatorContract {
  return createCoordinatorContract(new InMemoryCoordinatorFacade());
}

export const _coord: MinimalCoordinatorContract = createInMemoryCoordinatorContract();
