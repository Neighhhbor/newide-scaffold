import type {
  AgentProjection,
  TaskSpecification,
  BidLedger,
  AuditBundle,
  ScoreBreakdownDetail,
} from './models';
import { SelectionEngine } from './selection-engine';

/**
 * Market 层的统一门面
 */
export interface MarketResult {
  winnerAgentId: string;
  winnerBidId: string;
  ledger: BidLedger;
  auditBundle: AuditBundle;
  scoreBreakdowns: Map<string, ScoreBreakdownDetail>;
}

export class MarketFacade {
  private selectionEngine: SelectionEngine;
  private auditBundles: Map<string, AuditBundle> = new Map();

  constructor(tau: number = 0.5) {
    this.selectionEngine = new SelectionEngine(tau);
  }

  /**
   * 主流程：任务进入市场，所有 Agent 竞标，选出获胜者
   */
  public async marketAuction(
    agents: AgentProjection[],
    task: TaskSpecification,
  ): Promise<MarketResult> {
    // 步骤 1: 广播 + 收集竞标
    const { ledger, scoreBreakdowns } = this.selectionEngine.broadcastAndCollect(agents, task);

    // 步骤 2: 排序竞标（备用，在这里不使用）
    // const rankedBids = this.selectionEngine.rankBids(ledger.bids)

    // 步骤 3: Softmax sampling 选择获胜者
    const scores = ledger.bids.map((bid) => ({
      agentId: bid.agent_id,
      score: bid.final_score,
    }));
    const winnerAgentId = this.selectionEngine.selectWinner(scores);
    const winnerBid = ledger.bids.find((b) => b.agent_id === winnerAgentId);
    if (!winnerBid) throw new Error(`Winner bid for agent ${winnerAgentId} not found`);

    // 步骤 4: 找出获胜者的 agent projection 和 score breakdown
    const winnerAgent = agents.find((a) => a.agent_id === winnerAgentId);
    if (!winnerAgent) throw new Error(`Winner agent ${winnerAgentId} not found`);

    const winnerScoreBreakdown = scoreBreakdowns.get(winnerAgentId);
    if (!winnerScoreBreakdown) throw new Error(`Score breakdown for winner not found`);

    // 步骤 5: 生成审计产物
    const auditBundle = this.selectionEngine.generateAuditBundle(
      winnerBid.bid_id,
      ledger.bids,
      winnerAgent,
      winnerScoreBreakdown,
    );

    this.auditBundles.set(task.task_id, auditBundle);

    return {
      winnerAgentId,
      winnerBidId: winnerBid.bid_id,
      ledger,
      auditBundle,
      scoreBreakdowns,
    };
  }

  /**
   * 获取审计产物
   */
  public getAuditBundle(taskId: string): AuditBundle | undefined {
    return this.auditBundles.get(taskId);
  }

  /**
   * 查询竞标历史
   */
  public getBidLedger(_taskId: string): BidLedger | undefined {
    // 这里在实际应用中应该从存储系统查询
    return undefined;
  }

  /**
   * 获取得分明细（用于透明度和可解释性）
   */
  public getScoreExplanation(scoreBreakdown: ScoreBreakdownDetail): string {
    return `
Final Score: ${(scoreBreakdown.final_score * 100).toFixed(2)}%
├─ Relevance (40%): ${(scoreBreakdown.relevance * 100).toFixed(2)}%
│  ├─ Persona Match: ${(scoreBreakdown.relevance_breakdown.persona_match * 100).toFixed(2)}%
│  ├─ Skill Match: ${(scoreBreakdown.relevance_breakdown.skill_match * 100).toFixed(2)}%
│  └─ Experience Match: ${(scoreBreakdown.relevance_breakdown.experience_match * 100).toFixed(2)}%
├─ Quality (30%): ${(scoreBreakdown.quality * 100).toFixed(2)}%
│  ├─ Success Rate: ${(scoreBreakdown.quality_breakdown.recent_success_rate * 100).toFixed(2)}%
│  ├─ Avg Confidence: ${(scoreBreakdown.quality_breakdown.avg_confidence * 100).toFixed(2)}%
│  ├─ Experience Density: ${(scoreBreakdown.quality_breakdown.experience_density * 100).toFixed(2)}%
│  └─ Skill Density: ${(scoreBreakdown.quality_breakdown.skill_density * 100).toFixed(2)}%
├─ Capacity (15%): ${(scoreBreakdown.capacity * 100).toFixed(2)}%
├─ Freshness (15%): ${(scoreBreakdown.freshness * 100).toFixed(2)}%
└─ Bonus: ${scoreBreakdown.bonus > 0 ? '+' + (scoreBreakdown.bonus * 100).toFixed(2) + '%' : 'None'}
`;
  }
}
