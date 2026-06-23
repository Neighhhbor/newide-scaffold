import { describe, expect, it } from 'vitest';
import {
  _coord,
  createInMemoryCoordinatorContract,
} from '../../src/coordinator/coordinator-contract';

describe('coordinator contract-facing API', () => {
  it('exposes task operations through the spec-c _coord namespace', () => {
    const coord = createInMemoryCoordinatorContract();

    const task = coord.task.create({
      spec: 'Create task through contract-facing API.',
      completion_criteria: ['Task is created through _coord.task.create.'],
    });

    expect(task.status).toBe('created');
    expect(coord.task.claim(task.task_id, 'agent_driver').status).toBe('claimed');
    expect(coord.task.update_status(task.task_id, 'running').status).toBe('running');
  });

  it('exposes mailbox operations through the spec-c _coord namespace', () => {
    const coord = createInMemoryCoordinatorContract();

    const sent = coord.message.send({
      thread_id: 'thread_1',
      from_agent_id: 'agent_source',
      to: [{ agent_id: 'agent_target' }],
      type: 'handoff',
      payload: { summary: 'Use the contract-facing mailbox API.' },
      requires_ack: true,
      deadline_seconds: 30,
    });

    expect(sent.message.message_id).toMatch(/^message_/);
    expect(sent.deliveries).toHaveLength(1);

    const ackResult = coord.message.ack(sent.message.message_id, {
      agent_id: 'agent_target',
    });

    expect(ackResult).toBeUndefined();
  });

  it('keeps the exported _coord namespace available as the default instance', () => {
    expect(_coord.task.create).toBeTypeOf('function');
    expect(_coord.message.send).toBeTypeOf('function');
  });
});
