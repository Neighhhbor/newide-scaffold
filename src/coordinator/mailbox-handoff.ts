/**
 * Coordinator mailbox handoff 模块。
 *
 * 这个文件只负责 integration-v0 的 mailbox 消息构造和投递状态推进：
 * task.assigned、driver.requested、driver.requested ack、driver.completed。
 * 它不调用 driver，不写 event log，不修改 task/run 状态，也不处理 gate、checkpoint 或输出文件。
 */
import type { DriverId, DriverSessionId, RunId, TaskId } from '../core';
import type { DriverRunResult } from '../driver';
import type { InMemoryMailboxStore, MessageDelivery, SendMessageResult } from './mailbox-store';

export interface SendTaskAssignedMessageInput {
  mailbox: InMemoryMailboxStore;
  thread_id: RunId;
  task_id: TaskId;
  driver_id: DriverId;
  driver_session_id: DriverSessionId;
}

export interface SendDriverRequestedMessageInput {
  mailbox: InMemoryMailboxStore;
  thread_id: RunId;
  task_id: TaskId;
  run_id: RunId;
  driver_id: DriverId;
  prompt: string;
}

export interface SendDriverRequestedMessageResult extends SendMessageResult {
  acked_delivery: MessageDelivery;
}

export interface SendDriverCompletedMessageInput {
  mailbox: InMemoryMailboxStore;
  thread_id: RunId;
  task_id: TaskId;
  run_id: RunId;
  driver_id: DriverId;
  driver_result: DriverRunResult;
}

export function sendTaskAssignedMessage(input: SendTaskAssignedMessageInput): SendMessageResult {
  return input.mailbox.send({
    thread_id: input.thread_id,
    from_agent_id: 'coordinator',
    to: [{ agent_id: input.driver_id }],
    type: 'task.assigned',
    payload: {
      task_id: input.task_id,
      agent_id: input.driver_id,
      session_id: input.driver_session_id,
    },
    requires_ack: false,
  });
}

export function sendDriverRequestedMessage(
  input: SendDriverRequestedMessageInput,
): SendDriverRequestedMessageResult {
  const result = input.mailbox.send({
    thread_id: input.thread_id,
    from_agent_id: 'coordinator',
    to: [{ agent_id: input.driver_id }],
    type: 'driver.requested',
    payload: {
      task_id: input.task_id,
      run_id: input.run_id,
      prompt: input.prompt,
    },
    requires_ack: true,
    deadline_seconds: 300,
  });

  const ackedDelivery = input.mailbox.ack(result.message.message_id, {
    agent_id: input.driver_id,
  });

  return {
    ...result,
    acked_delivery: ackedDelivery,
  };
}

export function sendDriverCompletedMessage(
  input: SendDriverCompletedMessageInput,
): SendMessageResult {
  return input.mailbox.send({
    thread_id: input.thread_id,
    from_agent_id: input.driver_id,
    to: [{ agent_id: 'coordinator' }],
    type: 'driver.completed',
    payload: {
      task_id: input.task_id,
      run_id: input.run_id,
      status: input.driver_result.status,
      artifact_count: input.driver_result.artifacts.length,
      driver_run_result_id: input.driver_result.driver_run_result_id,
    },
    requires_ack: false,
  });
}
