import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, type ArtifactRef } from '../../src/core';
import type {
  DriverCapabilities,
  DriverPrompt,
  DriverRunResult,
  DriverRuntimeHandle,
} from '../../src/driver';
import { DriverRuntimeAgentExecutionFacade } from '../../src/memory';

describe('DriverRuntimeAgentExecutionFacade', () => {
  it('runs an agent through a DriverRuntimeHandle and returns an AgentExecutionResult', async () => {
    const driver = new CapturingDriver('succeeded');
    const facade = new DriverRuntimeAgentExecutionFacade({ driver });

    const result = await facade.runAgent({
      task_id: 'task_001',
      run_id: 'run_001',
      role_id: 'proposer_a',
      instruction: 'Produce a candidate implementation.',
      input_artifact_refs: ['artifact_input_001'],
      context_policy: 'default',
      schema_version: SCHEMA_VERSION,
    });

    expect(driver.prompts).toHaveLength(1);
    expect(driver.prompts[0]).toMatchObject({
      task_id: 'task_001',
      run_id: 'run_001',
      prompt: 'Produce a candidate implementation.',
      context_pack_ref: {
        task_id: 'task_001',
        schema_version: SCHEMA_VERSION,
      },
      schema_version: SCHEMA_VERSION,
    });
    expect(result).toMatchObject({
      agent_run_id: expect.stringMatching(/^agent_run_/),
      role_id: 'proposer_a',
      context_pack_ref: expect.stringMatching(/^context_pack_/),
      driver_run_result_id: 'driver_result_001',
      artifact_refs: [createArtifact('artifact_output_001')],
      transcript_ref: createArtifact('artifact_transcript_001', 'transcript'),
      diagnostics: {
        driver_id: 'driver_001',
        driver_status: 'succeeded',
        context_policy: 'default',
        input_artifact_refs: ['artifact_input_001'],
      },
      status: 'completed',
      schema_version: SCHEMA_VERSION,
    });
    expect(result.created_at).toEqual(expect.any(String));
  });

  it('maps failed driver results to failed agent execution results', async () => {
    const driver = new CapturingDriver('failed');
    const facade = new DriverRuntimeAgentExecutionFacade({ driver });

    const result = await facade.runAgent({
      task_id: 'task_001',
      run_id: 'run_001',
      role_id: 'reviewer',
      instruction: 'Review the candidate.',
      input_artifact_refs: [],
      context_policy: 'default',
      schema_version: SCHEMA_VERSION,
    });

    expect(result.status).toBe('failed');
    expect(result.diagnostics).toMatchObject({
      driver_status: 'failed',
      driver_error_code: 'MOCK_FAILED',
    });
  });
});

class CapturingDriver implements DriverRuntimeHandle {
  readonly driver_id = 'driver_001';
  readonly session_id = 'session_001';
  readonly capabilities: DriverCapabilities = {
    supports_acp_extension: false,
    supports_structured_output: true,
    supports_session_load: false,
    supports_tool_events: false,
    supports_permission_events: false,
  };
  readonly prompts: DriverPrompt[] = [];

  constructor(private readonly status: DriverRunResult['status']) {}

  async sendPrompt(input: DriverPrompt): Promise<DriverRunResult> {
    this.prompts.push(input);
    return {
      driver_run_result_id: 'driver_result_001',
      session_id: this.session_id,
      status: this.status,
      artifacts: this.status === 'succeeded' ? [createArtifact('artifact_output_001')] : [],
      transcript_ref: createArtifact('artifact_transcript_001', 'transcript'),
      tool_events: [],
      diagnostics: {
        driver_id: this.driver_id,
        duration_ms: 25,
        notes: ['captured'],
      },
      ...(this.status === 'failed'
        ? {
            error: {
              code: 'MOCK_FAILED',
              message: 'Mock driver failed.',
              retryable: false,
            },
          }
        : {}),
      created_at: '2026-07-07T00:00:00.000Z',
      schema_version: SCHEMA_VERSION,
    };
  }

  async interrupt(_reason: string): Promise<void> {}

  async collectTranscript(): Promise<ArtifactRef> {
    return createArtifact('artifact_transcript_001', 'transcript');
  }
}

function createArtifact(artifactId: string, type: ArtifactRef['type'] = 'patch'): ArtifactRef {
  return {
    artifact_id: artifactId,
    type,
    uri: `artifact://${type}/${artifactId}`,
    producer_id: 'driver_001',
    task_id: 'task_001',
    created_at: '2026-07-07T00:00:00.000Z',
    schema_version: SCHEMA_VERSION,
  };
}
