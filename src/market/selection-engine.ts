import type {
  AgentProjection,
  TaskSpecification,
  Bid,
  BidLedger,
  AuditBundle,
  ScoreBreakdownDetail,
} from './models';
import { BidSchema, AuditBundleSchema } from './models';
import { ScoringEngine } from './scoring-engine';

/**
 * 选择引擎 - 负责生成竞标、排序和选择获胜者
 */
export class SelectionEngine {
  private scoringEngine: ScoringEngine;
  private tau: number = 0.5; // softmax temperature，范围 [0.3, 1.0]

  constructor(tau: number = 0.5) {
    this.scoringEngine = new ScoringEngine();
    if (tau < 0.3 || tau > 1.0) {
      throw new Error('tau must be between 0.3 and 1.0');
    }
    this.tau = tau;
  }

  /**
   * 生成竞标
   */
  public generateBid(
    agent: AgentProjection,
    task: TaskSpecification,
    bidId: string,
    scoreBreakdown: ScoreBreakdownDetail,
  ): Bid {
    const strategy = this.generateStrategy(agent, task, scoreBreakdown);

    return BidSchema.parse({
      bid_id: bidId,
      task_id: task.task_id,
      agent_id: agent.agent_id,
      score_breakdown: {
        skill_match: scoreBreakdown.relevance_breakdown.skill_match,
        experience_match: scoreBreakdown.relevance_breakdown.experience_match,
      },
      final_score: scoreBreakdown.final_score,
      estimated_time: this.estimateTime(agent, task),
      strategy_summary: strategy,
      timestamp: Date.now(),
    });
  }

  /**
   * 生成策略摘要
   */
  private generateStrategy(
    agent: AgentProjection,
    task: TaskSpecification,
    _scoreBreakdown: ScoreBreakdownDetail,
  ): string {
    const topSkills = agent.skills.slice(0, 2).map((s) => s.name);
    const topExperience = agent.experience.slice(0, 2).map((e) => e.name);

    const parts = [];
    if (topSkills.length > 0) parts.push(`leverage ${topSkills.join(', ')}`);
    if (topExperience.length > 0) parts.push(`apply experience in ${topExperience.join(', ')}`);
    if (task.context.exploration_level > 0.7) parts.push('explore new approaches');

    return parts.join(' + ') || 'standard execution';
  }

  /**
   * 估计完成时间
   */
  private estimateTime(agent: AgentProjection, task: TaskSpecification): number {
    const baseTime = 3600; // 1 小时基准
    const urgencyFactor = 1 - task.context.urgency; // 紧急性越高，预计时间越短
    const loadFactor = 1 + agent.load_state.active_task_count * 0.2; // 任务越多，预计时间越长
    const experienceFactor = 1 - agent.metrics_ref.avg_confidence * 0.2; // 经验越丰富，预计时间越短

    return Math.round(baseTime * urgencyFactor * loadFactor * experienceFactor);
  }

  /**
   * 使用 softmax sampling 选择获胜者
   */
  public selectWinner(scores: Array<{ agentId: string; score: number }>): string {
    if (scores.length === 0) throw new Error('No scores provided');

    // 计算调整后的得分
    const adjusted = scores.map(({ agentId, score }) => ({
      agentId,
      adjusted: Math.exp(score / this.tau),
    }));

    // 计算概率
    const sum = adjusted.reduce((total, item) => total + item.adjusted, 0);
    const probabilities = adjusted.map(({ agentId, adjusted }) => ({
      agentId,
      probability: adjusted / sum,
    }));

    // 随机抽样
    const random = Math.random();
    let cumulative = 0;

    for (const { agentId, probability } of probabilities) {
      cumulative += probability;
      if (random <= cumulative) {
        return agentId;
      }
    }

    // 保底返回最后一个
    const lastProbability = probabilities[probabilities.length - 1];
    if (!lastProbability) throw new Error('Internal error: no probabilities');
    return lastProbability.agentId;
  }

  /**
   * 获取所有竞标的排序列表
   */
  public rankBids(bids: Bid[]): Bid[] {
    return [...bids].sort((a, b) => b.final_score - a.final_score);
  }

  /**
   * 生成审计产物
   */
  public generateAuditBundle(
    winnerBidId: string,
    bids: Bid[],
    winnerAgent: AgentProjection,
    scoreBreakdown: ScoreBreakdownDetail,
  ): AuditBundle {
    const winnerBid = bids.find((b) => b.bid_id === winnerBidId);
    if (!winnerBid) throw new Error(`Winner bid ${winnerBidId} not found`);

    const primaryReasons = [];
    if (scoreBreakdown.relevance > 0.7) primaryReasons.push('strong skill-domain match');
    if (scoreBreakdown.quality > 0.7) primaryReasons.push('high success rate');
    if (scoreBreakdown.capacity > 0.7) primaryReasons.push('low load');

    const risks = [];
    if (scoreBreakdown.quality < 0.5) risks.push('lower success rate');
    if (scoreBreakdown.capacity < 0.3) risks.push('high current load');
    if (winnerAgent.load_state.active_task_count > 2) risks.push('already managing multiple tasks');

    return AuditBundleSchema.parse({
      task_id: winnerBid.task_id,
      winner_bid: winnerBidId,
      all_bids: bids.map((b) => b.bid_id),
      selection_mode: 'weighted_sampling',
      decision_explanation: {
        primary_reason: primaryReasons.join(' + ') || 'best overall fit',
        secondary_reason: scoreBreakdown.bonus > 0 ? 'newcomer bonus applied' : undefined,
      },
      owner_report: {
        why_me:
          scoreBreakdown.relevance_breakdown.skill_match > 0.8
            ? 'best skill match'
            : 'balanced capability fit',
        risk_ack: risks.length > 0 ? risks.join('; ') : undefined,
        coordination_plan:
          winnerAgent.load_state.active_task_count > 1 ? 'may escalate to reviewer' : undefined,
      },
      timestamp: Date.now(),
    });
  }

  /**
   * 市场广播 - 所有 Agent 生成竞标
   */
  public broadcastAndCollect(
    agents: AgentProjection[],
    task: TaskSpecification,
  ): {
    ledger: BidLedger;
    scoreBreakdowns: Map<string, ScoreBreakdownDetail>;
  } {
    const bids: Bid[] = [];
    const scoreBreakdowns = new Map<string, ScoreBreakdownDetail>();
    let bidCounter = 0;

    for (const agent of agents) {
      const scoreBreakdown = this.scoringEngine.calculateScore(agent, task);
      scoreBreakdowns.set(agent.agent_id, scoreBreakdown);

      const bid = this.generateBid(agent, task, `bid_${bidCounter++}`, scoreBreakdown);
      bids.push(bid);
    }

    const ledger: BidLedger = {
      task_id: task.task_id,
      bids,
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    return { ledger, scoreBreakdowns };
  }
}
