import type { FrontendRunSnapshot } from '../coordinator/frontend-run-snapshot';
import type { RunSnapshot } from '../protocol/run-snapshot';
import type { AppRunSnapshot } from './run-registry';

export function projectRunSnapshot(input: AppRunSnapshot): RunSnapshot {
  const rich = input.snapshot;
  const artifacts = asRecords(rich?.artifacts ?? []);
  const finalStatus = terminalStatus(input.status);

  return {
    schema_version: input.schema_version,
    run_id: input.run_id,
    task_id: input.task_id,
    mode: input.mode,
    status: input.status,
    current: { ...input.current },
    timeline: [...input.events],
    agent_runs: input.events
      .filter((event) => event.source === 'agent')
      .map((event) => ({
        event_id: event.event_id,
        type: event.type,
        created_at: event.created_at,
        ...event.payload,
      })),
    artifacts,
    gates: input.events
      .filter((event) => event.source === 'gate')
      .map((event) => ({
        event_id: event.event_id,
        type: event.type,
        created_at: event.created_at,
        ...event.payload,
      })),
    ...(input.mode === 'council' ? { council: projectCouncil(input, rich) } : {}),
    ...(rich?.checkpoint ? { checkpoint: asRecord(rich.checkpoint) } : {}),
    errors: input.error ? [{ ...input.error }] : [],
    ...(finalStatus
      ? {
          final_output: {
            status: finalStatus,
            artifact_refs: artifactIds(artifacts),
            files_written: [...(rich?.delivery_report.files_written ?? [])],
          },
        }
      : {}),
  };
}

function projectCouncil(
  input: AppRunSnapshot,
  rich: FrontendRunSnapshot | undefined,
): NonNullable<RunSnapshot['council']> {
  const council = rich?.council;
  return {
    enabled: true,
    status: input.status,
    ...(council?.decision_id ? { decision_id: council.decision_id } : {}),
    ...(council?.verdict ? { verdict: council.verdict } : {}),
    ...(council?.decision_mode ? { decision_mode: council.decision_mode } : {}),
    selected_artifact_refs: [...(council?.selected_artifact_refs ?? [])],
    required_next_actions: [...(council?.output?.required_next_actions ?? [])],
    blocked_by: [...(council?.output?.blocked_by ?? [])],
    can_create_merge_authorization: council?.can_create_merge_authorization ?? false,
    ...(council?.proposals ? { proposals: asRecords(council.proposals) } : {}),
    ...(council?.reviews ? { reviews: asRecords(council.reviews) } : {}),
    ...(council?.synthesis ? { synthesis: asRecord(council.synthesis) } : {}),
    ...(council?.output ? { output: asRecord(council.output) } : {}),
  };
}

function terminalStatus(
  status: AppRunSnapshot['status'],
): 'completed' | 'failed' | 'cancelled' | undefined {
  return status === 'running' ? undefined : status;
}

function artifactIds(artifacts: Record<string, unknown>[]): string[] {
  return artifacts.flatMap((artifact) =>
    typeof artifact.artifact_id === 'string' ? [artifact.artifact_id] : [],
  );
}

function asRecords(values: readonly unknown[]): Record<string, unknown>[] {
  return values.map(asRecord);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? { ...value } : { value };
}
