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
    checkpoint(request: CoordinatorCheckpointRequest): CoordinatorCheckpoint;
    load(threadId: ThreadId, checkpointId?: CheckpointId): CoordinatorCheckpoint | undefined;
    list_history(
      threadId: ThreadId,
      options?: CoordinatorCheckpointHistoryOptions,
    ): CoordinatorCheckpointMeta[];
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
