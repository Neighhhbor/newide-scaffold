import type { AgentId, MessageId, MessageRecipient, TaskId } from '../core';
import { InMemoryCoordinatorFacade } from './coordinator-facade';
import type { CoordinatorTask, CoordinatorTaskCreateRequest } from './coordinator-facade';
import type { MessageDelivery, SendMessageInput, SendMessageResult } from './mailbox-store';
import type { CoordinatorTaskStatus } from './task-state-machine';

export interface CoordinatorFacadeLike {
  createTask(request: CoordinatorTaskCreateRequest): CoordinatorTask;
  claimTask(taskId: TaskId, agentId: AgentId): CoordinatorTask;
  updateTaskStatus(taskId: TaskId, status: CoordinatorTaskStatus, reason?: string): CoordinatorTask;
  sendMessage(input: SendMessageInput): SendMessageResult;
  ackMessage(messageId: MessageId, recipient: MessageRecipient): MessageDelivery;
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
  };
}

export function createInMemoryCoordinatorContract(): MinimalCoordinatorContract {
  return createCoordinatorContract(new InMemoryCoordinatorFacade());
}

export const _coord: MinimalCoordinatorContract = createInMemoryCoordinatorContract();
