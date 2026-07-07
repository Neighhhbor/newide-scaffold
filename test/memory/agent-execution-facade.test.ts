import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '../../src/core';
import { AGENT_EXECUTION_STATUSES } from '../../src/memory';
import type {
  AgentExecutionFacade,
  AgentExecutionRequest,
  AgentExecutionResult,
} from '../../src/memory';

describe('AgentExecutionFacade contract', () => {
  it('exports the minimal agent execution status vocabulary', () => {
    expect(AGENT_EXECUTION_STATUSES).toEqual(['completed', 'failed', 'cancelled', 'interrupted']);
  });

  it('defines the B-owned agent execution boundary without creating C task or run ids', async () => {
    const requests: AgentExecutionRequest[] = [];
    const facade: AgentExecutionFacade = {
      async runAgent(input) {
        requests.push(input);
        return createAgentExecutionResult(input);
      },
    };

    const request: AgentExecutionRequest = {
      task_id: 'task_001',
      run_id: 'run_001',
      role_id: 'proposer_a',
      instruction: 'Produce a candidate implementation.',
      input_artifact_refs: ['artifact_context_001'],
      context_policy: 'default',
      schema_version: SCHEMA_VERSION,
    };

    const result = await facade.runAgent(request);

    expect(requests).toEqual([request]);
    expect(result).toEqual({
      agent_run_id: 'agent_run_001',
      role_id: 'proposer_a',
      context_pack_ref: 'context_pack_001',
      driver_run_result_id: 'driver_result_001',
      artifact_refs: ['artifact_candidate_001'],
      transcript_ref: 'artifact_transcript_001',
      diagnostics: {
        driver_id: 'driver_001',
      },
      status: 'completed',
      memory_buffer_ref: 'memory_buffer_001',
      created_at: '2026-07-07T00:00:00.000Z',
      schema_version: SCHEMA_VERSION,
    });
  });
});

function createAgentExecutionResult(input: AgentExecutionRequest): AgentExecutionResult {
  return {
    agent_run_id: 'agent_run_001',
    role_id: input.role_id,
    context_pack_ref: 'context_pack_001',
    driver_run_result_id: 'driver_result_001',
    artifact_refs: ['artifact_candidate_001'],
    transcript_ref: 'artifact_transcript_001',
    diagnostics: {
      driver_id: 'driver_001',
    },
    status: 'completed',
    memory_buffer_ref: 'memory_buffer_001',
    created_at: '2026-07-07T00:00:00.000Z',
    schema_version: SCHEMA_VERSION,
  };
}
