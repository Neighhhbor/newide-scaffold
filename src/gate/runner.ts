import type {
  GateRunner,
  GateDefinition,
  GateRequest,
  GateResult,
  GateDecision,
  GateOutputConfig,
} from './gate';
import type { GateResultId } from '../core';

/**
 * Abstract base class for all GateRunners.
 * Provides common result-building helpers.
 */
export abstract class BaseGateRunner implements GateRunner {
  constructor(readonly gate_id: string) {}

  abstract run(request: GateRequest): Promise<GateResult>;

  // Static build method declaration, assigned externally to prevent circular dependencies
  static build: (
    gateId: string,
    definition: GateDefinition,
    resolver?: (gateId: string) => Promise<GateRunner>,
  ) => BaseGateRunner;

  /** Build a GateResult with sensible defaults */
  protected buildResult(
    request: GateRequest,
    decision: GateDecision,
    reason: string,
    overrides?: Partial<Pick<GateResult, 'required_actions' | 'audit_ref' | 'target_state'>>,
  ): GateResult {
    return {
      gate_result_id: `${this.gate_id}_${request.request_id}` as GateResultId,
      gate_id: this.gate_id,
      gate_point: request.gate_point,
      request_id: request.request_id,
      decision,
      reason,
      required_actions: overrides?.required_actions ?? [],
      audit_ref: overrides?.audit_ref ?? '',
      target_state: overrides?.target_state ?? '',
      created_at: new Date().toISOString(),
      schema_version: request.schema_version,
    };
  }

  /** Map a severity/finding level to a GateDecision using output config */
  protected mapSeverity(severity: string, outputConfig: GateOutputConfig): GateDecision {
    if (outputConfig.severity_map?.[severity]) {
      return outputConfig.severity_map[severity];
    }
    // Default fallback: error → deny, warning → ask, info → allow
    const defaults: Record<string, GateDecision> = {
      error: 'deny',
      critical: 'deny',
      high: 'deny',
      warning: 'ask',
      moderate: 'ask',
      info: 'allow',
      low: 'allow',
    };
    return defaults[severity.toLowerCase()] ?? 'allow';
  }
}
