import {
  SCHEMA_VERSION,
  createId,
  nowTimestamp,
  type AgentMessageType,
  type ArtifactId,
  type CheckpointId,
  type Message,
  type MessageId,
  type MessageRecipient,
  type SchemaVersion,
  type ThreadId,
  type Timestamp,
} from '../core';

/**
 * Mailbox MVP：持久化消息主体 + 为每个接收方创建投递记录。
 *
 * - Message 是线程里的事实记录，按 thread_id 可回放。
 * - Delivery 是面向接收方的投递状态，支持 pending -> acked 的最小闭环。
 * - requires_ack 的消息必须带 deadline_seconds，避免产生无 deadline 的无限等待语义。
 *
 * 当前未实现 timeout/retry 自动推进；这些字段先保留在 MessageDelivery 上，
 * 后续由 message timeout API 或调度器切片接入。
 */
export type MessageDeliveryStatus = 'pending' | 'delivered' | 'acked' | 'timeout' | 'failed';
export type MessageTimeoutAction = 'retry' | 'blocked' | 'failed' | 'waiting_input';

export interface SendMessageInput {
  thread_id: ThreadId;
  from_agent_id: string;
  to: MessageRecipient[];
  type: AgentMessageType;
  payload: Record<string, unknown>;
  artifact_refs?: ArtifactId[];
  checkpoint_ref?: CheckpointId;
  causal_event_id?: string;
  requires_ack: boolean;
  deadline_seconds?: number;
}

export interface MessageDelivery {
  delivery_id: string;
  message_id: MessageId;
  recipient_agent_id?: string;
  recipient_role_id?: string;
  status: MessageDeliveryStatus;
  deadline_at?: Timestamp;
  ack_at?: Timestamp;
  timeout_at?: Timestamp;
  retry_count: number;
  max_retries: number;
  current_attempt_id?: string;
  next_retry_at?: Timestamp;
  on_timeout: MessageTimeoutAction;
  last_delivery_event_id?: string;
  replay_cursor?: string;
  schema_version: SchemaVersion;
}

export interface SendMessageResult {
  message: Message;
  deliveries: MessageDelivery[];
}

export class InMemoryMailboxStore {
  private readonly messages = new Map<MessageId, Message>();
  private readonly deliveries = new Map<string, MessageDelivery>();

  send(input: SendMessageInput): SendMessageResult {
    if (input.requires_ack && input.deadline_seconds === undefined) {
      throw new Error('requires_ack messages must set deadline_seconds');
    }
    this.assertRecipients(input.to);

    const message: Message = {
      message_id: createId('message'),
      thread_id: input.thread_id,
      from_agent_id: input.from_agent_id,
      to: input.to,
      type: input.type,
      payload: input.payload,
      ...(input.artifact_refs ? { artifact_refs: input.artifact_refs } : {}),
      ...(input.checkpoint_ref ? { checkpoint_ref: input.checkpoint_ref } : {}),
      ...(input.causal_event_id ? { causal_event_id: input.causal_event_id } : {}),
      requires_ack: input.requires_ack,
      ...(input.deadline_seconds !== undefined ? { deadline_seconds: input.deadline_seconds } : {}),
      created_at: nowTimestamp(),
      schema_version: SCHEMA_VERSION,
    };
    const deliveries = input.to.map((recipient) =>
      this.createDelivery(message.message_id, recipient, input),
    );

    this.messages.set(message.message_id, message);
    for (const delivery of deliveries) {
      this.deliveries.set(delivery.delivery_id, delivery);
    }

    return { message, deliveries };
  }

  ack(messageId: MessageId, recipient: MessageRecipient): MessageDelivery {
    const delivery = this.findDelivery(messageId, recipient);
    if (!delivery) {
      throw new Error(`Delivery for message ${messageId} was not found`);
    }

    const acked: MessageDelivery = {
      ...delivery,
      status: 'acked',
      ack_at: nowTimestamp(),
    };
    this.deliveries.set(acked.delivery_id, acked);
    return acked;
  }

  listThread(threadId: ThreadId): Message[] {
    return [...this.messages.values()].filter((message) => message.thread_id === threadId);
  }

  listDeliveries(messageId?: MessageId): MessageDelivery[] {
    const deliveries = [...this.deliveries.values()];
    return messageId
      ? deliveries.filter((delivery) => delivery.message_id === messageId)
      : deliveries;
  }

  private createDelivery(
    messageId: MessageId,
    recipient: MessageRecipient,
    input: SendMessageInput,
  ): MessageDelivery {
    const deadlineAt =
      input.deadline_seconds !== undefined
        ? new Date(Date.now() + input.deadline_seconds * 1000).toISOString()
        : undefined;

    return {
      delivery_id: createId('delivery'),
      message_id: messageId,
      ...(recipient.agent_id ? { recipient_agent_id: recipient.agent_id } : {}),
      ...(recipient.role_id ? { recipient_role_id: recipient.role_id } : {}),
      status: 'pending',
      ...(deadlineAt ? { deadline_at: deadlineAt } : {}),
      retry_count: 0,
      max_retries: 0,
      on_timeout: 'blocked',
      schema_version: SCHEMA_VERSION,
    };
  }

  private assertRecipients(recipients: MessageRecipient[]): void {
    if (recipients.length === 0) {
      throw new Error('messages must have at least one recipient');
    }

    for (const recipient of recipients) {
      const targetCount =
        Number(recipient.agent_id !== undefined) + Number(recipient.role_id !== undefined);
      if (targetCount !== 1) {
        throw new Error('message recipients must set exactly one of agent_id or role_id');
      }
    }
  }

  private findDelivery(
    messageId: MessageId,
    recipient: MessageRecipient,
  ): MessageDelivery | undefined {
    return [...this.deliveries.values()].find((delivery) => {
      if (delivery.message_id !== messageId) {
        return false;
      }

      const matchesAgent =
        recipient.agent_id !== undefined && delivery.recipient_agent_id === recipient.agent_id;
      const matchesRole =
        recipient.role_id !== undefined && delivery.recipient_role_id === recipient.role_id;

      return matchesAgent || matchesRole;
    });
  }
}
