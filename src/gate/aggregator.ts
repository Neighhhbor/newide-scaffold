import type { GateDecision, GateResult, SubGateRef } from './gate';

const DECISION_RANK: Record<GateDecision, number> = {
  allow: 0,
  defer: 1,
  ask: 2,
  deny: 3,
};

export class DecisionAggregator {
  aggregate(results: GateResult[]): GateResult {
    if (results.length === 0) {
      throw new Error('DecisionAggregator requires at least one GateResult');
    }

    return results.reduce((strictest, current) =>
      DECISION_RANK[current.decision] > DECISION_RANK[strictest.decision] ? current : strictest,
    );
  }

  /**
   * Aggregates sub-gate results for a composite gate.
   * If a sub-gate is NOT required (required === false), its 'deny' decision is NOT treated as a final 'deny'.
   * Other decision values are still aggregated.
   */
  aggregateComposite(results: GateResult[], subGates: SubGateRef[]): GateResult {
    if (results.length === 0) {
      throw new Error(
        'DecisionAggregator requires at least one GateResult for composite aggregation',
      );
    }

    const subGateMap = new Map<string, SubGateRef>(subGates.map((sg) => [sg.gate_id, sg]));

    const adjustedResults = results.map((res) => {
      const config = subGateMap.get(res.gate_id);
      // If config is found and required is explicitly false, and decision is deny,
      // downgrade/map it to 'allow' so it does not block the composite gate.
      if (config && config.required === false && res.decision === 'deny') {
        return {
          ...res,
          decision: 'allow' as GateDecision,
          reason: `${res.reason} (ignored deny because optional)`,
        };
      }
      return res;
    });

    return this.aggregate(adjustedResults);
  }
}
