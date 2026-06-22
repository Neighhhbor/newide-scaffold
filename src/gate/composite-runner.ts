import { BaseGateRunner } from './runner';
import type { GateRequest, GateResult, GateDefinition, GateRunner } from './gate';
import { DecisionAggregator } from './aggregator';
import type { GateResultId } from '../core';

export class CompositeRunner extends BaseGateRunner {
  constructor(
    gate_id: string,
    private readonly definition: GateDefinition,
    private readonly resolver: (gateId: string) => Promise<GateRunner>,
  ) {
    super(gate_id);
  }

  async run(request: GateRequest): Promise<GateResult> {
    const subGates = this.definition.gates;
    if (!subGates || subGates.length === 0) {
      return this.buildResult(request, 'allow', 'CompositeRunner has no sub-gates to evaluate.');
    }

    const subResults: GateResult[] = [];
    for (const subGate of subGates) {
      try {
        const runner = await this.resolver(subGate.gate_id);
        const subResult = await runner.run({
          ...request,
          gate_id: subGate.gate_id,
        });
        subResults.push(subResult);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const onFailDecision = this.definition.outputConfig?.on_fail ?? 'deny';
        const dummyResult: GateResult = {
          gate_result_id: `${subGate.gate_id}_${request.request_id}` as GateResultId,
          gate_id: subGate.gate_id,
          gate_point: request.gate_point,
          request_id: request.request_id,
          decision: onFailDecision,
          reason: `Failed to execute sub-gate ${subGate.gate_id}: ${message}`,
          required_actions: [],
          audit_ref: '',
          target_state: '',
          created_at: new Date().toISOString(),
          schema_version: request.schema_version,
        };
        subResults.push(dummyResult);
      }
    }

    const aggregator = new DecisionAggregator();
    const aggregatedResult = aggregator.aggregateComposite(subResults, subGates);

    return this.buildResult(
      request,
      aggregatedResult.decision,
      `Composite gate evaluation: ${aggregatedResult.reason}`,
      {
        required_actions: aggregatedResult.required_actions,
        audit_ref: `audit://composite/${this.gate_id}/${request.request_id}`,
      },
    );
  }
}
