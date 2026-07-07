import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '../../src/core';
import { InMemoryMailboxStore } from '../../src/coordinator/mailbox-store';
import {
  sendDriverCompletedMessage,
  sendDriverRequestedMessage,
  sendTaskAssignedMessage,
} from '../../src/coordinator/mailbox-handoff';
import type { DriverRunResult } from '../../src/driver';

describe('integration mailbox handoff', () => {
  it('should record task assignment, driver request ack, and driver completion messages', () => {
    const mailbox = new InMemoryMailboxStore();
    const driverResult = createDriverResult();

    const taskAssigned = sendTaskAssignedMessage({
      mailbox,
      thread_id: 'run_001',
      task_id: 'task_001',
      driver_id: 'driver_001',
      driver_session_id: 'session_001',
    });
    const driverRequested = sendDriverRequestedMessage({
      mailbox,
      thread_id: 'run_001',
      task_id: 'task_001',
      run_id: 'run_001',
      driver_id: 'driver_001',
      prompt: 'Build the v0 integration flow',
    });
    const driverCompleted = sendDriverCompletedMessage({
      mailbox,
      thread_id: 'run_001',
      task_id: 'task_001',
      run_id: 'run_001',
      driver_id: 'driver_001',
      driver_result: driverResult,
    });

    const messageRefs = [
      taskAssigned.message.message_id,
      driverRequested.message.message_id,
      driverCompleted.message.message_id,
    ];
    const thread = mailbox.listThread('run_001');
    const deliveries = mailbox.listDeliveries();

    expect(messageRefs).toHaveLength(3);
    expect(thread.map((message) => message.type)).toEqual([
      'task.assigned',
      'driver.requested',
      'driver.completed',
    ]);
    expect(deliveries).toHaveLength(3);

    const driverRequestedMessage = thread.find((message) => message.type === 'driver.requested');
    if (!driverRequestedMessage) {
      throw new Error('driver.requested message was not found');
    }
    const requestedDelivery = deliveries.find(
      (delivery) => delivery.message_id === driverRequestedMessage.message_id,
    );

    expect(requestedDelivery).toMatchObject({
      recipient_agent_id: 'driver_001',
      status: 'acked',
    });
    expect(requestedDelivery?.ack_at).toBeDefined();
    expect(driverRequested.acked_delivery.delivery_id).toBe(requestedDelivery?.delivery_id);
  });
});

function createDriverResult(): DriverRunResult {
  return {
    driver_run_result_id: 'driver_run_result_001',
    session_id: 'session_001',
    status: 'succeeded',
    artifacts: [
      {
        artifact_id: 'artifact_001',
        type: 'diff',
        uri: 'artifact://diff/task_001/result.patch',
        producer_id: 'driver_001',
        task_id: 'task_001',
        created_at: '2026-07-07T00:00:00.000Z',
        schema_version: SCHEMA_VERSION,
      },
    ],
    transcript_ref: {
      artifact_id: 'artifact_transcript_001',
      type: 'transcript',
      uri: 'artifact://transcript/task_001/result.json',
      producer_id: 'driver_001',
      task_id: 'task_001',
      created_at: '2026-07-07T00:00:00.000Z',
      schema_version: SCHEMA_VERSION,
    },
    tool_events: [],
    diagnostics: {
      driver_id: 'driver_001',
      duration_ms: 100,
      notes: [],
    },
    created_at: '2026-07-07T00:00:00.000Z',
    schema_version: SCHEMA_VERSION,
  };
}
