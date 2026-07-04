import { describe, it, expect, beforeEach } from 'vitest';
import { ScoringEngine } from './scoring-engine';
import { SelectionEngine } from './selection-engine';
import type { AgentProjection, TaskSpecification } from './models';

describe('Market Bidding System', () => {
  let scoringEngine: ScoringEngine;
  let selectionEngine: SelectionEngine;

  const mockAgent: AgentProjection = {
    agent_id: 'test_agent',
    persona_ref: 'test_v1',
    persona: {
      python: 0.9,
      sql: 0.85,
      concurrency: 0.8,
    },
    skills: [
      { name: 'optimization', confidence: 0.9, tags: ['implementer'] },
      { name: 'database', confidence: 0.85, tags: ['designer'] },
    ],
    experience: [
      { name: 'scaling', type: 'positive', confidence: 0.85 },
      { name: 'debugging', type: 'positive', confidence: 0.8 },
    ],
    metrics_ref: {
      total_tasks: 20,
      last_20_tasks_succeeded: 18,
      skill_count: 2,
      experience_count: 2,
      avg_confidence: 0.85,
    },
    load_state: {
      active_task_count: 1,
      days_since_last_task: 0,
    },
  };

  const mockTask: TaskSpecification = {
    task_id: 'test_task_001',
    task_description: 'Test optimization task',
    requirement_profile: {
      persona_requirements: {
        python: 0.8,
        sql: 0.8,
      },
      domain_requirements: {
        system_domain: 'backend',
        scale_level: 0.85,
        risk_level: 'high',
      },
      role_hint: {
        preferred_role_tags: ['implementer', 'designer'],
      },
    },
    context: {
      urgency: 0.8,
      exploration_level: 0.3,
    },
  };

  beforeEach(() => {
    scoringEngine = new ScoringEngine();
    selectionEngine = new SelectionEngine(0.5);
  });

  describe('ScoringEngine', () => {
    it('should calculate scores correctly', () => {
      const scoreBreakdown = scoringEngine.calculateScore(mockAgent, mockTask);

      expect(scoreBreakdown.final_score).toBeGreaterThan(0);
      expect(scoreBreakdown.final_score).toBeLessThanOrEqual(1);
      expect(scoreBreakdown.relevance).toBeGreaterThan(0);
      expect(scoreBreakdown.quality).toBeGreaterThan(0);
      expect(scoreBreakdown.capacity).toBeGreaterThan(0);
      expect(scoreBreakdown.freshness).toBeGreaterThan(0);
    });

    it('should apply newcomer bonus for agents with < 5 tasks', () => {
      const newbieAgent = {
        ...mockAgent,
        metrics_ref: { ...mockAgent.metrics_ref, total_tasks: 2 },
      };

      const scoreBreakdown = scoringEngine.calculateScore(newbieAgent, mockTask);

      expect(scoreBreakdown.bonus).toBe(0.15);
      expect(scoreBreakdown.final_score).toBeGreaterThan(0.15);
    });

    it('should not apply bonus for agents with >= 5 tasks', () => {
      const scoreBreakdown = scoringEngine.calculateScore(mockAgent, mockTask);

      expect(scoreBreakdown.bonus).toBe(0);
    });

    it('should calculate relevance based on persona, skill, and experience', () => {
      const scoreBreakdown = scoringEngine.calculateScore(mockAgent, mockTask);

      expect(scoreBreakdown.relevance_breakdown.persona_match).toBeGreaterThan(0);
      expect(scoreBreakdown.relevance_breakdown.skill_match).toBeGreaterThan(0);
      expect(scoreBreakdown.relevance_breakdown.experience_match).toBeGreaterThan(0);
    });

    it('should penalize agents with high load', () => {
      const busyAgent = {
        ...mockAgent,
        load_state: { ...mockAgent.load_state, active_task_count: 5 },
      };

      const normalScore = scoringEngine.calculateScore(mockAgent, mockTask);
      const busyScore = scoringEngine.calculateScore(busyAgent, mockTask);

      expect(busyScore.capacity).toBeLessThan(normalScore.capacity);
      expect(busyScore.final_score).toBeLessThan(normalScore.final_score);
    });

    it('should consider days_since_last_task for freshness', () => {
      const inactiveAgent = {
        ...mockAgent,
        load_state: { ...mockAgent.load_state, days_since_last_task: 30 },
      };

      const activeScore = scoringEngine.calculateScore(mockAgent, mockTask);
      const inactiveScore = scoringEngine.calculateScore(inactiveAgent, mockTask);

      expect(activeScore.freshness).toBeGreaterThan(inactiveScore.freshness);
    });
  });

  describe('SelectionEngine', () => {
    it('should generate valid bids', () => {
      const scoreBreakdown = scoringEngine.calculateScore(mockAgent, mockTask);
      const bid = selectionEngine.generateBid(mockAgent, mockTask, 'bid_001', scoreBreakdown);

      expect(bid.bid_id).toBe('bid_001');
      expect(bid.task_id).toBe(mockTask.task_id);
      expect(bid.agent_id).toBe(mockAgent.agent_id);
      expect(bid.final_score).toBeGreaterThan(0);
      expect(bid.estimated_time).toBeGreaterThan(0);
      expect(bid.strategy_summary).toBeTruthy();
    });

    it('should rank bids correctly by score', () => {
      const agent1 = { ...mockAgent, agent_id: 'agent1' };
      const agent2 = {
        ...mockAgent,
        agent_id: 'agent2',
        metrics_ref: { ...mockAgent.metrics_ref, avg_confidence: 0.6 },
      };

      const score1 = scoringEngine.calculateScore(agent1, mockTask);
      const score2 = scoringEngine.calculateScore(agent2, mockTask);

      const bid1 = selectionEngine.generateBid(agent1, mockTask, 'bid_1', score1);
      const bid2 = selectionEngine.generateBid(agent2, mockTask, 'bid_2', score2);

      const ranked = selectionEngine.rankBids([bid2, bid1]);

      expect(ranked[0]?.final_score).toBeGreaterThanOrEqual(ranked[1]?.final_score ?? 0);
    });

    it('should select a winner using softmax sampling', () => {
      const scores = [
        { agentId: 'alice', score: 0.9 },
        { agentId: 'bob', score: 0.7 },
        { agentId: 'charlie', score: 0.5 },
      ];

      const winner = selectionEngine.selectWinner(scores);

      expect(['alice', 'bob', 'charlie']).toContain(winner);
    });

    it('should throw error if no scores provided', () => {
      expect(() => {
        selectionEngine.selectWinner([]);
      }).toThrow('No scores provided');
    });

    it('should broadcast and collect bids from all agents', () => {
      const agents: AgentProjection[] = [
        { ...mockAgent, agent_id: 'alice' },
        { ...mockAgent, agent_id: 'bob' },
        { ...mockAgent, agent_id: 'charlie' },
      ];

      const { ledger, scoreBreakdowns } = selectionEngine.broadcastAndCollect(agents, mockTask);

      expect(ledger.task_id).toBe(mockTask.task_id);
      expect(ledger.bids).toHaveLength(3);
      expect(scoreBreakdowns.size).toBe(3);
      expect(
        ledger.bids.every((b: (typeof ledger.bids)[0]) => b.task_id === mockTask.task_id),
      ).toBe(true);
    });

    it('should generate valid audit bundle', () => {
      const scoreBreakdown = scoringEngine.calculateScore(mockAgent, mockTask);
      const bid = selectionEngine.generateBid(mockAgent, mockTask, 'bid_001', scoreBreakdown);

      const auditBundle = selectionEngine.generateAuditBundle(
        bid.bid_id,
        [bid],
        mockAgent,
        scoreBreakdown,
      );

      expect(auditBundle.task_id).toBe(mockTask.task_id);
      expect(auditBundle.winner_bid).toBe('bid_001');
      expect(auditBundle.all_bids).toContain('bid_001');
      expect(auditBundle.selection_mode).toBe('weighted_sampling');
      expect(auditBundle.decision_explanation.primary_reason).toBeTruthy();
      expect(auditBundle.owner_report.why_me).toBeTruthy();
    });
  });

  describe('Integration', () => {
    it('should complete full market auction', () => {
      const agents: AgentProjection[] = [
        { ...mockAgent, agent_id: 'alice' },
        {
          ...mockAgent,
          agent_id: 'bob',
          metrics_ref: { ...mockAgent.metrics_ref, avg_confidence: 0.6 },
        },
      ];

      const { ledger, scoreBreakdowns } = selectionEngine.broadcastAndCollect(agents, mockTask);

      expect(ledger.bids).toHaveLength(2);
      expect(scoreBreakdowns.size).toBe(2);

      const scores = ledger.bids.map((b: (typeof ledger.bids)[0]) => ({
        agentId: b.agent_id,
        score: b.final_score,
      }));
      const winner = selectionEngine.selectWinner(scores);

      expect(agents.map((a) => a.agent_id)).toContain(winner);

      // Verify alice should have higher score than bob (due to higher avg_confidence)
      const aliceScore = scoreBreakdowns.get('alice')?.final_score ?? 0;
      const bobScore = scoreBreakdowns.get('bob')?.final_score ?? 0;

      expect(aliceScore).toBeGreaterThan(bobScore);
    });
  });
});
