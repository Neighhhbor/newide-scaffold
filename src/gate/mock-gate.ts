import { SCHEMA_VERSION, createId, nowTimestamp } from '../core';
import type { GateDecision, GateRequest, GateResult, GateRunner } from './gate';

export class MockAllowGate implements GateRunner {
  readonly gate_id: string;

  constructor(gateId = 'allow-gate') {
    this.gate_id = gateId;
  }

  async run(request: GateRequest): Promise<GateResult> {
    return buildGateResult(
      request,
      'allow',
      'Mock allow gate accepted the subject.',
      [],
      'allowed',
    );
  }
}

export class MockDenyGate implements GateRunner {
  readonly gate_id: string;

  constructor(gateId = 'deny-gate') {
    this.gate_id = gateId;
  }

  async run(request: GateRequest): Promise<GateResult> {
    return buildGateResult(
      request,
      'deny',
      'Mock deny gate blocked the subject.',
      ['fix'],
      'blocked',
    );
  }
}

export interface CommandGateOptions {
  gate_id: string;
  command: () => Promise<{ exit_code: number; stdout?: string; stderr?: string }>;
}

export class CommandGate implements GateRunner {
  readonly gate_id: string;
  private readonly command: CommandGateOptions['command'];

  constructor(options: CommandGateOptions) {
    this.gate_id = options.gate_id;
    this.command = options.command;
  }

  async run(request: GateRequest): Promise<GateResult> {
    const commandResult = await this.command();
    const decision: GateDecision = commandResult.exit_code === 0 ? 'allow' : 'deny';

    return buildGateResult(
      request,
      decision,
      commandResult.exit_code === 0
        ? 'CommandGate command succeeded.'
        : `CommandGate command failed with exit code ${commandResult.exit_code}.`,
      commandResult.exit_code === 0 ? [] : ['inspect-command-output'],
      commandResult.exit_code === 0 ? 'allowed' : 'blocked',
      {
        exit_code: commandResult.exit_code,
        stdout: commandResult.stdout,
        stderr: commandResult.stderr,
      },
    );
  }
}

function buildGateResult(
  request: GateRequest,
  decision: GateDecision,
  reason: string,
  requiredActions: string[],
  targetState: string,
  auditMetadata?: Record<string, unknown>,
): GateResult {
  const gateResultId = createId('gate_result');

  return {
    gate_result_id: gateResultId,
    gate_id: request.gate_id,
    gate_point: request.gate_point,
    subject_id: request.subject_id,
    decision,
    reason,
    required_actions: requiredActions,
    audit_ref: `artifact://audit/${request.gate_id}/${gateResultId}`,
    target_state: targetState,
    created_at: nowTimestamp(),
    schema_version: SCHEMA_VERSION,
    ...(auditMetadata ? { metadata: auditMetadata } : {}),
  } as GateResult;
}
