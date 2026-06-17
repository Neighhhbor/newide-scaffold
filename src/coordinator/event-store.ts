import {
  SCHEMA_VERSION,
  createId,
  nowTimestamp,
  type Event,
  type EventType,
  type RunId,
  type TaskId,
} from '../core';

export interface AppendEventInput {
  event_type: EventType;
  subject_id: string;
  run_id?: RunId;
  task_id?: TaskId;
  payload?: Record<string, unknown>;
}

export class InMemoryEventStore {
  private readonly events: Event[] = [];

  append(input: AppendEventInput): Event {
    const event: Event = {
      event_id: createId('event'),
      event_type: input.event_type,
      subject_id: input.subject_id,
      ...(input.run_id ? { run_id: input.run_id } : {}),
      ...(input.task_id ? { task_id: input.task_id } : {}),
      payload: input.payload ?? {},
      created_at: nowTimestamp(),
      schema_version: SCHEMA_VERSION,
    };

    this.events.push(event);
    return event;
  }

  list(): Event[] {
    return [...this.events];
  }
}
