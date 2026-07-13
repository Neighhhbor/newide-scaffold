import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, type ArtifactRef } from '../core';
import { MockLlmClient } from '../memory/adapters/mock-llm-client';
import type { DriverRunResult } from './contract';
import {
  createDefaultDriverReturnConverter,
  createLlmDriverReturnConverter,
  parseDriverReturnFromTranscript,
} from './driver-return-converter';

const SAMPLE_DRIVER_RETURN = {
  artifacts: [
    {
      type: 'file',
      path: 'artifact://driver_result/task_llm/result.json',
      summary: 'Generated result artifact',
    },
  ],
  summary: 'Task completed successfully via LLM generation.',
  decisions: [
    {
      point: 'Execution approach',
      options: ['delegate', 'direct'],
      chosen: 'delegate',
      reason: 'Driver was best suited for the task.',
    },
  ],
  blockers: [],
  referenced_experiences: [],
  assumptions: [
    {
      assumption: 'The generated artifact is valid.',
      risk_if_wrong: 'Downstream consumers may fail.',
    },
  ],
};

const INSTRUCTION = 'Generate a structured six-field report from the driver result.';

describe('parseDriverReturnFromTranscript', () => {
  it('parses tagged DriverReturn blocks', () => {
    const text = `Some transcript text\n<<<DRIVER_RETURN>>>\n${JSON.stringify(SAMPLE_DRIVER_RETURN)}\n<<<END_DRIVER_RETURN>>>\nMore text`;
    const result = parseDriverReturnFromTranscript(text);
    expect(result).toEqual(SAMPLE_DRIVER_RETURN);
  });

  it('parses JSON code blocks', () => {
    const text = `\`\`\`json\n${JSON.stringify(SAMPLE_DRIVER_RETURN)}\n\`\`\``;
    const result = parseDriverReturnFromTranscript(text);
    expect(result).toEqual(SAMPLE_DRIVER_RETURN);
  });

  it('returns null when no structured block is present', () => {
    const result = parseDriverReturnFromTranscript('plain transcript without json');
    expect(result).toBeNull();
  });
});

describe('createDefaultDriverReturnConverter', () => {
  it('returns parsed DriverReturn when transcript contains structured block', async () => {
    const converter = createDefaultDriverReturnConverter();
    const transcriptText = `<<<DRIVER_RETURN>>>\n${JSON.stringify(SAMPLE_DRIVER_RETURN)}\n<<<END_DRIVER_RETURN>>>`;
    const result = await converter(driverRunResult(), { transcriptText, instruction: INSTRUCTION });
    expect(result).toEqual(SAMPLE_DRIVER_RETURN);
  });

  it('falls back to construction when transcript lacks structured block', async () => {
    const converter = createDefaultDriverReturnConverter();
    const result = await converter(driverRunResult(), {
      transcriptText: 'plain text',
      instruction: INSTRUCTION,
    });
    expect(result.summary).toContain('llm-test-driver');
    expect(result.artifacts).toHaveLength(1);
  });
});

describe('createLlmDriverReturnConverter', () => {
  it('parses transcript block without calling LLM when available', async () => {
    const llm = new MockLlmClient([]);
    const converter = createLlmDriverReturnConverter(llm);
    const transcriptText = `<<<DRIVER_RETURN>>>\n${JSON.stringify(SAMPLE_DRIVER_RETURN)}\n<<<END_DRIVER_RETURN>>>`;

    const result = await converter(driverRunResult(), { transcriptText, instruction: INSTRUCTION });

    expect(result).toEqual(SAMPLE_DRIVER_RETURN);
  });

  it('calls LLM and returns parsed DriverReturn', async () => {
    const llm = new MockLlmClient([{ response: JSON.stringify(SAMPLE_DRIVER_RETURN) }]);
    const converter = createLlmDriverReturnConverter(llm);

    const result = await converter(driverRunResult(), { instruction: INSTRUCTION });

    expect(result).toEqual(SAMPLE_DRIVER_RETURN);
  });

  it('falls back to construction when LLM returns invalid JSON', async () => {
    const llm = new MockLlmClient([{ response: 'not-json' }]);
    const converter = createLlmDriverReturnConverter(llm);

    const result = await converter(driverRunResult(), { instruction: INSTRUCTION });

    expect(result.summary).toContain('llm-test-driver');
    expect(result.artifacts).toHaveLength(1);
  });

  it('falls back to construction when LLM response fails schema validation', async () => {
    const invalidResponse = JSON.stringify({ summary: 'missing other fields' });
    const llm = new MockLlmClient([{ response: invalidResponse }]);
    const converter = createLlmDriverReturnConverter(llm);

    const result = await converter(driverRunResult(), { instruction: INSTRUCTION });

    expect(result.summary).toContain('llm-test-driver');
  });

  it('falls back to construction when LLM throws', async () => {
    const llm = new MockLlmClient([{ response: 'ERROR:mock llm failure' }]);
    const converter = createLlmDriverReturnConverter(llm);

    const result = await converter(driverRunResult(), { instruction: INSTRUCTION });

    expect(result.summary).toContain('llm-test-driver');
  });
});

function driverRunResult(): DriverRunResult {
  const created_at = '2026-07-03T00:00:01.000Z';
  const transcript = artifactRef({
    artifact_id: 'artifact_transcript',
    type: 'transcript',
    uri: 'artifact://transcript/task_llm/session_llm',
    created_at,
  });

  return {
    driver_run_result_id: 'driver_result_llm',
    session_id: 'session_llm',
    status: 'succeeded',
    artifacts: [
      artifactRef({
        artifact_id: 'artifact_driver_result',
        type: 'driver_result',
        uri: 'artifact://driver_result/task_llm/driver_result_llm.json',
        created_at,
      }),
    ],
    transcript_ref: transcript,
    tool_events: [
      {
        tool_event_id: 'event_1',
        tool_name: 'write_file',
        status: 'completed',
        summary: 'Wrote result file',
        created_at,
        schema_version: SCHEMA_VERSION,
      },
    ],
    diagnostics: {
      driver_id: 'llm-test-driver',
      duration_ms: 42,
      notes: ['LLM converter test run.'],
    },
    created_at,
    schema_version: SCHEMA_VERSION,
  };
}

function artifactRef(input: {
  artifact_id: string;
  type: ArtifactRef['type'];
  uri: string;
  created_at: string;
}): ArtifactRef {
  return {
    artifact_id: input.artifact_id,
    type: input.type,
    uri: input.uri,
    producer_id: 'llm-test-driver',
    task_id: 'task_llm',
    created_at: input.created_at,
    schema_version: SCHEMA_VERSION,
  };
}
