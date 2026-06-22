import {
  SCHEMA_VERSION,
  createId,
  nowTimestamp,
  type Event,
  type RunId,
  type TaskId,
} from '../core';
import {
  getTelemetryCatalogEntry,
  requireTelemetryCatalogEntry,
  type TelemetryCatalogEntry,
  type TelemetryOwner,
} from './event-catalog';

export type TelemetrySourceKind =
  | 'harness'
  | 'proxy'
  | 'event_store'
  | 'b_memory'
  | 'c_coordination';

export interface TelemetrySourceRef {
  kind: TelemetrySourceKind;
  event_id?: string;
  artifact_id?: string;
  object_type?: string;
}

export interface TelemetryEmission {
  event_type: string;
  subject_id: string;
  subject_type?: string;
  run_id?: RunId;
  task_id?: TaskId;
  payload?: Record<string, unknown>;
  source?: TelemetrySourceRef;
}

export interface TelemetryRecord {
  telemetry_id: string;
  event_type: string;
  owner: TelemetryOwner;
  subject_id: string;
  subject_type?: string;
  run_id?: RunId;
  task_id?: TaskId;
  payload: Record<string, unknown>;
  source?: TelemetrySourceRef;
  created_at: string;
  schema_version: typeof SCHEMA_VERSION;
}

export interface TelemetrySink {
  emit(record: TelemetryRecord): void | Promise<void>;
}

export class NoopTelemetrySink implements TelemetrySink {
  emit(_record: TelemetryRecord): void {
    return undefined;
  }
}

export class InMemoryTelemetrySink implements TelemetrySink {
  private readonly records: TelemetryRecord[] = [];

  emit(record: TelemetryRecord): void {
    this.records.push(record);
  }

  list(): TelemetryRecord[] {
    return [...this.records];
  }
}

export function createTelemetryRecord(
  emission: TelemetryEmission,
  catalogEntry: TelemetryCatalogEntry = requireTelemetryCatalogEntry(emission.event_type),
): TelemetryRecord {
  return {
    telemetry_id: createId('telemetry'),
    event_type: emission.event_type,
    owner: catalogEntry.owner,
    subject_id: emission.subject_id,
    ...(emission.subject_type ? { subject_type: emission.subject_type } : {}),
    ...(emission.run_id ? { run_id: emission.run_id } : {}),
    ...(emission.task_id ? { task_id: emission.task_id } : {}),
    payload: emission.payload ?? {},
    ...(emission.source ? { source: emission.source } : {}),
    created_at: nowTimestamp(),
    schema_version: SCHEMA_VERSION,
  };
}

export function createTelemetryRecordFromEvent(event: Event): TelemetryRecord | undefined {
  const catalogEntry = getTelemetryCatalogEntry(event.event_type);
  if (!catalogEntry) {
    return undefined;
  }

  return createTelemetryRecord(
    {
      event_type: event.event_type,
      subject_id: event.subject_id,
      ...(event.run_id ? { run_id: event.run_id } : {}),
      ...(event.task_id ? { task_id: event.task_id } : {}),
      payload: event.payload,
      source: {
        kind: 'event_store',
        event_id: event.event_id,
      },
    },
    catalogEntry,
  );
}

export async function emitTelemetry(
  sink: TelemetrySink,
  emission: TelemetryEmission,
): Promise<TelemetryRecord> {
  const record = createTelemetryRecord(emission);
  await sink.emit(record);
  return record;
}

export async function mirrorEventToTelemetry(
  sink: TelemetrySink,
  event: Event,
): Promise<TelemetryRecord | undefined> {
  const record = createTelemetryRecordFromEvent(event);
  if (!record) {
    return undefined;
  }

  await sink.emit(record);
  return record;
}
