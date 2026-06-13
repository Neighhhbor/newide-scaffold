import type { GateDecision, GateResult } from "./gate";

const DECISION_RANK: Record<GateDecision, number> = {
  allow: 0,
  defer: 1,
  ask: 2,
  deny: 3
};

export class DecisionAggregator {
  aggregate(results: GateResult[]): GateResult {
    if (results.length === 0) {
      throw new Error("DecisionAggregator requires at least one GateResult");
    }

    return results.reduce((strictest, current) =>
      DECISION_RANK[current.decision] > DECISION_RANK[strictest.decision] ? current : strictest
    );
  }
}
