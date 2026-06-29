import { describe, expect, it } from 'vitest';
import { InMemoryMailboxStore } from '../../src/coordinator/mailbox-store';

describe('coordinator mailbox store', () => {
  it('requires a deadline for messages that need ack', () => {
    const mailbox = new InMemoryMailboxStore();

    expect(() =>
      mailbox.send({
        thread_id: 'thread_1',
        from_agent_id: 'agent_source',
        to: [{ agent_id: 'agent_target' }],
        type: 'ask_help',
        payload: { question: 'Can you review this?' },
        requires_ack: true,
      }),
    ).toThrow('requires_ack messages must set deadline_seconds');
  });

  it('requires at least one concrete recipient', () => {
    const mailbox = new InMemoryMailboxStore();

    expect(() =>
      mailbox.send({
        thread_id: 'thread_1',
        from_agent_id: 'agent_source',
        to: [],
        type: 'status_update',
        payload: { status: 'running' },
        requires_ack: false,
      }),
    ).toThrow('messages must have at least one recipient');

    expect(() =>
      mailbox.send({
        thread_id: 'thread_1',
        from_agent_id: 'agent_source',
        to: [{}],
        type: 'status_update',
        payload: { status: 'running' },
        requires_ack: false,
      }),
    ).toThrow('message recipients must set exactly one of agent_id or role_id');

    expect(() =>
      mailbox.send({
        thread_id: 'thread_1',
        from_agent_id: 'agent_source',
        to: [{ agent_id: 'agent_target', role_id: 'role_reviewer' }],
        type: 'status_update',
        payload: { status: 'running' },
        requires_ack: false,
      }),
    ).toThrow('message recipients must set exactly one of agent_id or role_id');
  });

  it('creates one delivery per recipient', () => {
    const mailbox = new InMemoryMailboxStore();

    const sent = mailbox.send({
      thread_id: 'thread_1',
      from_agent_id: 'agent_source',
      to: [{ agent_id: 'agent_target' }, { role_id: 'role_reviewer' }],
      type: 'ask_help',
      payload: { question: 'Can you review this?' },
      requires_ack: true,
      deadline_seconds: 30,
    });

    expect(sent.message).toMatchObject({
      thread_id: 'thread_1',
      from_agent_id: 'agent_source',
      type: 'ask_help',
      requires_ack: true,
      deadline_seconds: 30,
      schema_version: 'v0',
    });
    expect(sent.message.message_id).toMatch(/^message_/);
    expect(sent.deliveries).toHaveLength(2);
    expect(sent.deliveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message_id: sent.message.message_id,
          recipient_agent_id: 'agent_target',
          status: 'pending',
          retry_count: 0,
          max_retries: 0,
          on_timeout: 'blocked',
          schema_version: 'v0',
        }),
        expect.objectContaining({
          message_id: sent.message.message_id,
          recipient_role_id: 'role_reviewer',
          status: 'pending',
          retry_count: 0,
          max_retries: 0,
          on_timeout: 'blocked',
          schema_version: 'v0',
        }),
      ]),
    );
    for (const delivery of sent.deliveries) {
      expect(delivery.delivery_id).toMatch(/^delivery_/);
      expect(delivery.deadline_at).toBeDefined();
    }
  });

  it('acks an agent or role recipient delivery', () => {
    const mailbox = new InMemoryMailboxStore();
    const sent = mailbox.send({
      thread_id: 'thread_1',
      from_agent_id: 'agent_source',
      to: [{ agent_id: 'agent_target' }, { role_id: 'role_reviewer' }],
      type: 'handoff',
      payload: { summary: 'Continue from checkpoint.' },
      requires_ack: true,
      deadline_seconds: 30,
    });

    const agentAck = mailbox.ack(sent.message.message_id, { agent_id: 'agent_target' });
    const roleAck = mailbox.ack(sent.message.message_id, { role_id: 'role_reviewer' });

    expect(agentAck).toMatchObject({
      message_id: sent.message.message_id,
      recipient_agent_id: 'agent_target',
      status: 'acked',
    });
    expect(agentAck.ack_at).toBeDefined();
    expect(roleAck).toMatchObject({
      message_id: sent.message.message_id,
      recipient_role_id: 'role_reviewer',
      status: 'acked',
    });
    expect(roleAck.ack_at).toBeDefined();
  });

  it('lists messages by thread and deliveries by message', () => {
    const mailbox = new InMemoryMailboxStore();
    const first = mailbox.send({
      thread_id: 'thread_1',
      from_agent_id: 'agent_source',
      to: [{ agent_id: 'agent_target' }],
      type: 'status_update',
      payload: { status: 'running' },
      requires_ack: false,
    });
    const second = mailbox.send({
      thread_id: 'thread_1',
      from_agent_id: 'agent_source',
      to: [{ role_id: 'role_reviewer' }],
      type: 'review_request',
      payload: { artifact_id: 'artifact_1' },
      requires_ack: true,
      deadline_seconds: 60,
    });
    mailbox.send({
      thread_id: 'thread_2',
      from_agent_id: 'agent_source',
      to: [{ agent_id: 'agent_other' }],
      type: 'status_update',
      payload: { status: 'queued' },
      requires_ack: false,
    });

    expect(mailbox.listThread('thread_1')).toEqual([first.message, second.message]);
    expect(mailbox.listDeliveries(first.message.message_id)).toEqual(first.deliveries);
  });
});
