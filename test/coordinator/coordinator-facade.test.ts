import { describe, expect, it } from 'vitest';
import { InMemoryCoordinatorFacade } from '../../src/coordinator/coordinator-facade';
import { InMemoryMailboxStore } from '../../src/coordinator/mailbox-store';

describe('coordinator facade', () => {
  it('creates, claims, and updates a task through the spec-c state machine', () => {
    const coordinator = new InMemoryCoordinatorFacade();

    const task = coordinator.createTask({
      spec: 'Implement coordinator facade MVP.',
      completion_criteria: ['State updates are validated by the coordinator state machine.'],
    });
    expect(task).toMatchObject({
      status: 'created',
      risk_level: 'low',
      schema_version: 'v0',
    });
    expect(task.task_id).toMatch(/^task_/);

    expect(coordinator.claimTask(task.task_id, 'agent_driver').status).toBe('claimed');
    expect(coordinator.updateTaskStatus(task.task_id, 'running').status).toBe('running');
    expect(coordinator.updateTaskStatus(task.task_id, 'reviewing').status).toBe('reviewing');
    expect(coordinator.updateTaskStatus(task.task_id, 'completed').status).toBe('completed');
  });

  it('rejects invalid task status transitions at the facade boundary', () => {
    const coordinator = new InMemoryCoordinatorFacade();
    const task = coordinator.createTask({
      spec: 'Reject direct running transition.',
      completion_criteria: ['created cannot move directly to running.'],
    });

    expect(() => coordinator.updateTaskStatus(task.task_id, 'running')).toThrow(
      'Invalid task status transition: created -> running',
    );
    expect(coordinator.claimTask(task.task_id, 'agent_driver').status).toBe('claimed');
  });

  it('keeps spec-c extension fields on created tasks', () => {
    const coordinator = new InMemoryCoordinatorFacade();

    const task = coordinator.createTask({
      spec: 'Keep coordinator contract extension fields.',
      role_profile_ref: 'role_profile_reviewer',
      completion_criteria: ['Coordinator keeps the B role profile reference.'],
      retry_policy: {
        max_retries: 1,
        backoff: 'fixed',
      },
    });

    expect(task).toMatchObject({
      role_profile_ref: 'role_profile_reviewer',
      retry_policy: {
        max_retries: 1,
        backoff: 'fixed',
      },
    });
  });

  it('does not let another agent claim an already owned task', () => {
    const coordinator = new InMemoryCoordinatorFacade();
    const task = coordinator.createTask({
      spec: 'Protect task owner.',
      completion_criteria: ['A second agent cannot take over a claimed task.'],
    });

    expect(coordinator.claimTask(task.task_id, 'agent_driver').owner_agent_id).toBe('agent_driver');
    expect(coordinator.claimTask(task.task_id, 'agent_driver').owner_agent_id).toBe('agent_driver');
    expect(() => coordinator.claimTask(task.task_id, 'agent_other')).toThrow(
      `Task ${task.task_id} is already claimed by agent_driver`,
    );
  });

  it('sends and acks messages through the mailbox facade', () => {
    const mailbox = new InMemoryMailboxStore();
    const coordinator = new InMemoryCoordinatorFacade({ mailbox });

    const sent = coordinator.sendMessage({
      thread_id: 'thread_1',
      from_agent_id: 'agent_source',
      to: [{ agent_id: 'agent_target' }],
      type: 'ask_help',
      payload: { question: 'Can you review this?' },
      requires_ack: true,
      deadline_seconds: 30,
    });

    expect(sent.message.message_id).toMatch(/^message_/);
    expect(sent.deliveries).toHaveLength(1);

    coordinator.ackMessage(sent.message.message_id, { agent_id: 'agent_target' });

    expect(mailbox.listDeliveries(sent.message.message_id)).toEqual([
      expect.objectContaining({
        message_id: sent.message.message_id,
        recipient_agent_id: 'agent_target',
        status: 'acked',
      }),
    ]);
  });

  it('keeps mailbox ack deadline validation at the facade boundary', () => {
    const coordinator = new InMemoryCoordinatorFacade();

    expect(() =>
      coordinator.sendMessage({
        thread_id: 'thread_1',
        from_agent_id: 'agent_source',
        to: [{ agent_id: 'agent_target' }],
        type: 'ask_help',
        payload: { question: 'Can you review this?' },
        requires_ack: true,
      }),
    ).toThrow('requires_ack messages must set deadline_seconds');
  });
});
