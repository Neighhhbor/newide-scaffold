# Market Bidding System 集成指南

本指南展示如何将Market Bidding System集成到现有的Coordinator + Agent系统中。

## 架构集成点

```
新任务提交
    ↓
Coordinator.createTask()
    ↓
市场竞标 ← [Market Facade]
    ├─ Agent Projection 转换
    ├─ 评分
    ├─ Softmax Sampling 选择
    └─ 审计记录
    ↓
向获胜者分派任务 ← [Coordinator.assignTask()]
    ↓
获胜Agent执行任务
```

## 集成步骤

### 1. 创建Agent Projection提供器

在 `src/memory/runtime/agent.ts` 中添加方法，用于将Agent转换为Market Projection：

```typescript
import type { AgentProjection } from '@/market';

class Agent {
  // ... existing code ...

  /**
   * 为Market Bidding生成Agent Projection
   */
  toProjection(): AgentProjection {
    return {
      agent_id: this.id,
      persona_ref: this.personaRef,
      persona: this.getPersona(), // 从记忆系统获取
      skills: this.getSkills(), // 从记忆系统获取
      experience: this.getExperience(), // 从记忆系统获取
      metrics_ref: {
        total_tasks: this.metrics.totalTasks,
        last_20_tasks_succeeded: this.metrics.recentSuccessCount,
        skill_count: this.getSkills().length,
        experience_count: this.getExperience().length,
        avg_confidence: this.metrics.avgConfidence,
      },
      load_state: {
        active_task_count: this.getActiveTaskCount(),
        days_since_last_task: this.getDaysSinceLastTask(),
      },
    };
  }
}
```

### 2. 在Coordinator中集成Market

修改 `src/coordinator/orchestrator.ts`：

```typescript
import { MarketFacade, type TaskSpecification } from '@/market';
import type { Task } from '@/core';

class RuntimeOrchestrator {
  private market: MarketFacade;

  constructor(/* ... */) {
    this.market = new MarketFacade(0.5); // tau = 0.5 (balanced)
  }

  /**
   * 创建任务并进行市场竞标
   */
  async createTaskWithMarketAuction(
    taskSpec: Task,
    agents: Agent[], // 参与竞标的Agent列表
  ): Promise<{
    taskId: string;
    winnerAgentId: string;
    auditBundle: AuditBundle;
  }> {
    // 步骤1: 创建任务
    const taskId = await this.createTask(taskSpec);

    // 步骤2: 转换Agent投影
    const agentProjections = agents.map((a) => a.toProjection());

    // 步骤3: 转换任务规格
    const marketTaskSpec: TaskSpecification = {
      task_id: taskId,
      task_description: taskSpec.description,
      requirement_profile: {
        persona_requirements: taskSpec.personaRequirements || {},
        domain_requirements: {
          system_domain: taskSpec.domain,
          scale_level: taskSpec.scaleLevel || 0.5,
          risk_level: taskSpec.riskLevel || 'medium',
        },
        role_hint: {
          preferred_role_tags: taskSpec.preferredRoleTags || [],
        },
      },
      context: {
        urgency: taskSpec.urgency || 0.5,
        exploration_level: taskSpec.explorationLevel || 0.3,
      },
    };

    // 步骤4: 市场竞标
    const auctionResult = await this.market.marketAuction(agentProjections, marketTaskSpec);

    // 步骤5: 记录审计
    await this.registerAuditBundle(auctionResult.auditBundle);

    // 步骤6: 更新任务状态 - 标记为已分派
    await this.updateTaskState(taskId, 'claimed', {
      claimedBy: auctionResult.winnerAgentId,
    });

    return {
      taskId,
      winnerAgentId: auctionResult.winnerAgentId,
      auditBundle: auctionResult.auditBundle,
    };
  }

  /**
   * 注册审计产物
   */
  async registerAuditBundle(auditBundle: AuditBundle) {
    // 可选: 存储到数据库或审计日志
    await this.artifacts.register({
      type: 'audit_bundle',
      task_id: auditBundle.task_id,
      content: auditBundle,
      timestamp: Date.now(),
    });
  }
}
```

### 3. 在CoordinatorFacade中暴露API

修改 `src/coordinator/coordinator-facade.ts`：

```typescript
class CoordinatorFacade {
  // ... existing code ...

  /**
   * Market Layer API
   */
  market = {
    /**
     * 提交任务到市场竞标
     */
    submitForAuction: async (task: Task, agents: Agent[]) => {
      return this.orchestrator.createTaskWithMarketAuction(task, agents);
    },

    /**
     * 获取审计记录
     */
    getAuditBundle: (taskId: string) => {
      return this.orchestrator.getAuditBundle(taskId);
    },

    /**
     * 获取竞标历史
     */
    getBidHistory: (taskId: string) => {
      return this.orchestrator.getBidHistory(taskId);
    },
  };
}
```

## 使用示例

### 基础使用

```typescript
import { AgentManager } from '@/memory/runtime';
import { RuntimeOrchestrator } from '@/coordinator';
import type { Task } from '@/core';

const agentManager = new AgentManager(/* ... */);
const coordinator = new RuntimeOrchestrator(/* ... */);

// 创建任务
const task: Task = {
  id: 'task_001',
  description: 'Optimize database queries',
  domain: 'backend',
  riskLevel: 'high',
  urgency: 0.8,
  personaRequirements: {
    python: 0.8,
    sql: 0.85,
    concurrency: 0.75,
  },
  preferredRoleTags: ['implementer', 'optimizer'],
};

// 获取所有活跃Agent
const agents = agentManager.getActiveAgents();

// 提交到市场竞标
const result = await coordinator.market.submitForAuction(task, agents);

console.log(`✅ Winner: ${result.winnerAgentId}`);
console.log(`📋 Audit: ${result.auditBundle.decision_explanation.primary_reason}`);

// 获胜者开始执行
await coordinator.assignTask(result.taskId, result.winnerAgentId);
```

### 高级：自定义温度参数

```typescript
// 创建更保守的Market(高分Agent更容易赢)
const conservativeMarket = new MarketFacade((tau = 0.3));

// 创建更开放的Market(给低分Agent更多机会)
const openMarket = new MarketFacade((tau = 0.8));
```

### 监听事件

```typescript
// 在 Hook 中监听市场竞标完成事件
const hookEngine = new HookEngine(config);

hookEngine.on('market.auction_complete', async (event) => {
  const { task_id, winner_agent_id, audit_bundle } = event.data;

  console.log(`🏆 Task ${task_id} won by ${winner_agent_id}`);

  // 可选: 根据审计结果触发额外的闸门检查
  if (audit_bundle.owner_report.risk_ack) {
    // 启动高风险审查流程
    await hookEngine.trigger('market.high_risk_winner', {
      task_id,
      winner_agent_id,
      risks: audit_bundle.owner_report.risk_ack,
    });
  }
});
```

## 与记忆系统集成

Market需要从Agent的记忆系统中获取最新的Persona：

```typescript
// 在Agent.toProjection()中
toProjection(): AgentProjection {
  // 从记忆系统获取最新Persona快照
  const persona = this.memoryProvider.getPersonaSnapshot()

  // 从技能库获取技能
  const skills = this.memoryRepository.querySkills({
    agentId: this.id,
    status: 'active',  // 只取已激活的技能
  })

  // 从经验库获取经验(过滤掉已晋升的)
  const experience = this.memoryRepository.queryExperience({
    agentId: this.id,
    promoted: false,   // 只取未晋升的经验
  })

  return {
    agent_id: this.id,
    persona_ref: persona.ref,
    persona: persona.dimensions,
    skills,
    experience,
    metrics_ref: {
      total_tasks: this.runCount,
      last_20_tasks_succeeded: this.getRecentSuccessCount(20),
      skill_count: skills.length,
      experience_count: experience.length,
      avg_confidence: this.computeAvgConfidence(),
    },
    load_state: {
      active_task_count: this.getActiveRuns().length,
      days_since_last_task: this.getDaysSinceLastRun(),
    },
  }
}
```

## 测试集成

```typescript
import { describe, it, expect } from 'vitest';
import { createTestCoordinator } from '@/coordinator/test-utils';
import { createTestAgent } from '@/memory/test-utils';

describe('Coordinator + Market Integration', () => {
  it('should complete market auction and assign task', async () => {
    const coordinator = createTestCoordinator();
    const agents = [
      createTestAgent({ id: 'alice', avgConfidence: 0.9 }),
      createTestAgent({ id: 'bob', avgConfidence: 0.7 }),
    ];

    const task = {
      id: 'task_001',
      description: 'Test task',
      domain: 'backend',
    };

    const result = await coordinator.market.submitForAuction(task, agents);

    // 验证结果
    expect(result.taskId).toBe('task_001');
    expect(['alice', 'bob']).toContain(result.winnerAgentId);
    expect(result.auditBundle.task_id).toBe('task_001');

    // 验证审计记录被保存
    const auditBundle = await coordinator.market.getAuditBundle('task_001');
    expect(auditBundle).toBeDefined();
    expect(auditBundle?.all_bids.length).toBe(2);
  });
});
```

## 监控和可观测性

### 遥测集成

将Market事件转换为遥测记录：

```typescript
import { TelemetrySink } from '@/telemetry';

const telemetry = new InMemoryTelemetrySink();

market.on('auction_complete', (result) => {
  telemetry.emit({
    event_type: 'market.auction_complete',
    timestamp: Date.now(),
    data: {
      task_id: result.ledger.task_id,
      winner_agent_id: result.winnerAgentId,
      score_distribution: result.ledger.bids.map((b) => ({
        agent_id: b.agent_id,
        final_score: b.final_score,
      })),
      winner_score_breakdown: result.auditBundle.decision_explanation,
    },
  });
});
```

### 指标收集

```typescript
// 每日报告
const report = {
  total_auctions: count,
  avg_winner_score: avgScore,
  newcomer_win_rate: newcomerWins / totalAuctions,
  score_variance: stdDev(allScores),
  agent_win_distribution: winsByAgent,
};
```

## 常见问题

**Q: 如何确保公平性?**  
A: Market Bidding System使用确定的评分算法和可审计的竞标日志。每次拍卖都记录完整的AuditBundle，包括所有竞标、评分明细和决策理由。

**Q: Tau参数应该设置多少?**  
A:

- 0.3: 更接近贪心(精英主义，高分Agent更容易赢)
- 0.5: 平衡(推荐，给所有能力的Agent机会)
- 0.8: 更随机(公平性优先，鼓励多样性)

**Q: 如何处理Agent异议?**  
A: 可以扩展为支持异议机制——获胜者可以选择接受/拒绝任务，然后启动新的竞标轮次。

**Q: 能否根据历史结果调整权重?**  
A: 是的。可以定期分析Market历史，如果发现某个维度(如freshness)预测力不足，可以调整权重(如改为40/30/15/15)。

## 下一步工作

- [ ] 实现持久化的竞标日志存储
- [ ] 添加Market异议和重竞标机制
- [ ] 支持动态权重调整
- [ ] 构建Market仪表板(可视化竞标历史和Agent表现)
- [ ] 实现Agent反馈循环——Agent可以标注"我觉得这个任务不适合我"来改进评分
- [ ] 支持"试用期"任务(低风险测试新Agent)
