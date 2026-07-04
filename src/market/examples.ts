import { type AgentProjection, type TaskSpecification, MarketFacade } from './index';

/**
 * Market Bidding System Demo
 * Demonstrates the complete bidding, scoring and selection process
 */
export async function runMarketBiddingDemo() {
  console.log('[MARKET] Market Bidding System Demo\n');

  // Create 3 Agents
  const agents: AgentProjection[] = [
    {
      agent_id: 'alice',
      persona_ref: 'alice_v1',
      persona: {
        python: 0.95,
        sql: 0.9,
        concurrency: 0.8,
        security: 0.4,
      },
      skills: [
        { name: 'backend-optimization', confidence: 0.92, tags: ['implementer', 'optimizer'] },
        { name: 'database-design', confidence: 0.88, tags: ['designer'] },
      ],
      experience: [
        { name: 'scaling-postgres', type: 'positive', confidence: 0.85 },
        { name: 'race-condition-fix', type: 'positive', confidence: 0.9 },
        { name: 'slow-migration', type: 'negative', confidence: 0.7 },
      ],
      metrics_ref: {
        total_tasks: 45,
        last_20_tasks_succeeded: 18,
        skill_count: 5,
        experience_count: 12,
        avg_confidence: 0.83,
      },
      load_state: {
        active_task_count: 1,
        days_since_last_task: 0,
      },
    },
    {
      agent_id: 'bob',
      persona_ref: 'bob_v1',
      persona: {
        python: 0.7,
        sql: 0.85,
        concurrency: 0.6,
        security: 0.75,
      },
      skills: [
        { name: 'security-audit', confidence: 0.88, tags: ['security', 'reviewer'] },
        { name: 'api-design', confidence: 0.81, tags: ['designer'] },
      ],
      experience: [
        { name: 'xss-prevention', type: 'positive', confidence: 0.92 },
        { name: 'sql-injection-fix', type: 'positive', confidence: 0.88 },
      ],
      metrics_ref: {
        total_tasks: 32,
        last_20_tasks_succeeded: 19,
        skill_count: 4,
        experience_count: 8,
        avg_confidence: 0.79,
      },
      load_state: {
        active_task_count: 0,
        days_since_last_task: 1,
      },
    },
    {
      agent_id: 'charlie',
      persona_ref: 'charlie_v1',
      persona: {
        python: 0.5,
        sql: 0.6,
        concurrency: 0.4,
        security: 0.5,
      },
      skills: [{ name: 'bug-fixing', confidence: 0.7, tags: ['debugger'] }],
      experience: [{ name: 'memory-leak-debug', type: 'positive', confidence: 0.75 }],
      metrics_ref: {
        total_tasks: 2,
        last_20_tasks_succeeded: 2,
        skill_count: 1,
        experience_count: 1,
        avg_confidence: 0.72,
      },
      load_state: {
        active_task_count: 0,
        days_since_last_task: 3,
      },
    },
  ];

  // Create a task
  const task: TaskSpecification = {
    task_id: 'task_optimization_001',
    task_description:
      'Optimize the core database queries in the backend to reduce latency under high concurrency load',
    requirement_profile: {
      persona_requirements: {
        python: 0.8,
        sql: 0.85,
        concurrency: 0.75,
      },
      domain_requirements: {
        system_domain: 'backend',
        scale_level: 0.85,
        risk_level: 'high',
      },
      role_hint: {
        preferred_role_tags: ['implementer', 'optimizer', 'designer'],
      },
    },
    context: {
      urgency: 0.7,
      exploration_level: 0.4,
    },
  };

  // Create Market Facade
  const market = new MarketFacade(0.5);

  console.log('[TASK] Task Details:');
  console.log(`  ID: ${task.task_id}`);
  console.log(`  Description: ${task.task_description}`);
  console.log(
    `  Requirements: Python ${task.requirement_profile.persona_requirements.python}, SQL ${task.requirement_profile.persona_requirements.sql}\n`,
  );

  // Run market auction
  console.log('[AUCTION] Running Market Auction...\n');

  const result = await market.marketAuction(agents, task);

  // Display bid results
  console.log('[RESULTS] All Bids (Ranked):');
  let rank = 1;
  for (const bid of result.ledger.bids.sort((a, b) => b.final_score - a.final_score)) {
    const scoreBreakdown = result.scoreBreakdowns.get(bid.agent_id);
    console.log(
      `  ${rank}. ${bid.agent_id.toUpperCase()} (Score: ${(bid.final_score * 100).toFixed(2)}%)`,
    );
    if (scoreBreakdown) {
      console.log(`     - Relevance: ${(scoreBreakdown.relevance * 100).toFixed(2)}%`);
      console.log(`     - Quality: ${(scoreBreakdown.quality * 100).toFixed(2)}%`);
      console.log(`     - Capacity: ${(scoreBreakdown.capacity * 100).toFixed(2)}%`);
      console.log(`     - Strategy: ${bid.strategy_summary}`);
    }
    rank++;
  }

  console.log(`\n[WINNER] Winner: ${result.winnerAgentId.toUpperCase()}`);
  console.log(`   Winning Bid ID: ${result.winnerBidId}`);

  // Display audit bundle
  const audit = result.auditBundle;
  console.log('\n[AUDIT] Audit Bundle:');
  console.log(`  Task ID: ${audit.task_id}`);
  console.log(`  Selection Mode: ${audit.selection_mode}`);
  console.log(`  Primary Reason: ${audit.decision_explanation.primary_reason}`);
  if (audit.decision_explanation.secondary_reason) {
    console.log(`  Secondary Reason: ${audit.decision_explanation.secondary_reason}`);
  }

  console.log('\n[REPORT] Winner Report:');
  console.log(`  Why Me: ${audit.owner_report.why_me}`);
  if (audit.owner_report.risk_ack) {
    console.log(`  Risk Acknowledgement: ${audit.owner_report.risk_ack}`);
  }
  if (audit.owner_report.coordination_plan) {
    console.log(`  Coordination Plan: ${audit.owner_report.coordination_plan}`);
  }

  // Display winner's detailed score
  const winnerScoreBreakdown = result.scoreBreakdowns.get(result.winnerAgentId);
  if (winnerScoreBreakdown) {
    console.log('\n[SCORING] Detailed Score for Winner:');
    console.log(market.getScoreExplanation(winnerScoreBreakdown));
  }

  console.log('[COMPLETE] Market Bidding Demo Completed!');
}

// Run the demo
runMarketBiddingDemo().catch(console.error);
