import {
  emitTelemetry,
  type TelemetryEmission,
  type TelemetryRecord,
  type TelemetrySink,
} from './telemetry-sink';

export async function emitTelemetryBatch(
  sink: TelemetrySink,
  emissions: TelemetryEmission[],
): Promise<TelemetryRecord[]> {
  const records: TelemetryRecord[] = [];
  for (const emission of emissions) {
    records.push(await emitTelemetry(sink, emission));
  }
  return records;
}
