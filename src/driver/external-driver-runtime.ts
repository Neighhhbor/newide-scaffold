import type { ArtifactRef } from '../core';
import type {
  DriverCapabilities,
  DriverPrompt,
  DriverRunResult,
  DriverRuntimeHandle,
} from './contract';

export interface ExternalDriverTransport {
  invoke(input: DriverPrompt): Promise<DriverRunResult>;
  interrupt?(reason: string): Promise<void>;
  shutdown?(): Promise<void>;
}

export interface ExternalDriverRuntimeOptions {
  driver_id: string;
  session_id?: string;
  capabilities?: Partial<DriverCapabilities>;
  transport: ExternalDriverTransport;
}

const DEFAULT_CAPABILITIES: DriverCapabilities = {
  supports_acp_extension: false,
  supports_structured_output: true,
  supports_session_load: false,
  supports_tool_events: false,
  supports_permission_events: false,
};

export class ExternalDriverRuntime implements DriverRuntimeHandle {
  readonly driver_id: string;
  readonly session_id: string;
  readonly capabilities: DriverCapabilities;
  private readonly transport: ExternalDriverTransport;
  private latestTranscriptRef?: ArtifactRef;

  constructor(options: ExternalDriverRuntimeOptions) {
    this.driver_id = options.driver_id;
    this.session_id = options.session_id ?? `${options.driver_id}:session`;
    this.capabilities = {
      ...DEFAULT_CAPABILITIES,
      ...options.capabilities,
    };
    this.transport = options.transport;
  }

  async sendPrompt(input: DriverPrompt): Promise<DriverRunResult> {
    const result = await this.transport.invoke(input);
    assertDriverRunResult(result);
    this.latestTranscriptRef = result.transcript_ref;
    return result;
  }

  async interrupt(reason: string): Promise<void> {
    await this.transport.interrupt?.(reason);
  }

  async collectTranscript(): Promise<ArtifactRef> {
    if (!this.latestTranscriptRef) {
      throw new Error('External driver transcript is not available before sendPrompt completes');
    }

    return this.latestTranscriptRef;
  }

  async shutdown(): Promise<void> {
    await this.transport.shutdown?.();
  }
}

export function assertDriverRunResult(
  value: unknown,
  source = 'External driver',
): asserts value is DriverRunResult {
  const result = value as Partial<DriverRunResult>;

  if (!result.session_id) {
    throw malformedResult(source, 'session_id is required');
  }
  if (!result.driver_run_result_id) {
    throw malformedResult(source, 'driver_run_result_id is required');
  }
  if (!result.status) {
    throw malformedResult(source, 'status is required');
  }
  if (!Array.isArray(result.artifacts)) {
    throw malformedResult(source, 'artifacts must be an array');
  }
  if (!result.transcript_ref) {
    throw malformedResult(source, 'transcript_ref is required');
  }
  if (!Array.isArray(result.tool_events)) {
    throw malformedResult(source, 'tool_events must be an array');
  }
  if (!result.diagnostics?.driver_id) {
    throw malformedResult(source, 'diagnostics.driver_id is required');
  }
  if (!result.created_at) {
    throw malformedResult(source, 'created_at is required');
  }
  if (!result.schema_version) {
    throw malformedResult(source, 'schema_version is required');
  }
}

function malformedResult(source: string, reason: string): Error {
  return new Error(`${source} returned malformed DriverRunResult: ${reason}`);
}
