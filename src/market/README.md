# Market Bidding System (MVP)

一个为多Agent系统设计的**非侵入式任务竞标市场**。在不修改核心调度系统的前提下，提供可解释、可审计、可复现的Agent选择机制。

## 核心设计

### 数据流

```
Task
 ↓
Market Projection Layer (Agent 投影)
 ↓ (broadcast)
Agents generate bids (竞标)
 ↓
Bid Ledger (追加日志)
 ↓
Selection Engine (选择引擎)
 ↓ (decision_explanation + owner_report)
Winner
 ↓
Execution
```

### 评分函数

```
FinalScore =
    0.40 × relevance           # 人设/技能/经验匹配度
  + 0.30 × quality            # 成功率/信心/密度
  + 0.15 × capacity           # 当前负载情况
  + 0.15 × freshness          # 距上次任务的时间
  + bonus                     # 新手保护加分 (< 5 tasks 时 +0.15)
```

#### 相关性计算

```
relevance = 0.40 × persona_match + 0.30 × skill_match + 0.30 × experience_match

  persona_match: 任务需求的技能与Agent能力的比值
  skill_match: Agent是否具备任务所需的技能标签
  experience_match: Agent的正向经验置信度
```

#### 质量计算

```
quality = 0.50 × recent_success_rate
        + 0.30 × avg_confidence
        + 0.10 × experience_density
        + 0.10 × skill_density

  recent_success_rate: 最近20次任务的成功率(首次任务<3次时取0.5)
  avg_confidence: Agent的平均经验置信度
  experience_density: 经验数 / 总任务数
  skill_density: 技能数 / 经验数
```

#### 容量与新鲜度

```
capacity = 1.0 - min(1.0, active_task_count / 3)     # 当前任务数 > 3 时降分

freshness = 1.0 / (1.0 + days_since_last_task / 14)  # 不活跃时降分
```

## 核心模块

### 1. 数据模型 (`models.ts`)

- **AgentProjection**: Agent的能力投影
  - 人设(persona): 技能维度的评分
  - 技能(skills): 具体技能及置信度
  - 经验(experience): 正/负经验及置信度
  - 指标(metrics): 任务数、成功率、经验/技能密度、平均置信度
  - 负载(load_state): 当前活跃任务数、距上次任务的天数

- **TaskSpecification**: 任务规格
  - 需求档案: 人设要求、领域要求(风险等级)、角色提示
  - 上下文: 紧迫度、探索度

- **Bid**: 竞标记录
  - 评分明细(score_breakdown)
  - 最终得分(final_score)
  - 策略摘要(strategy_summary)

- **AuditBundle**: 审计产物
  - 获胜竞标ID + 所有竞标ID
  - 选择解释(决策理由)
  - Owner报告(为什么是我、风险确认、协调计划)

### 2. 评分引擎 (`scoring-engine.ts`)

```typescript
const engine = new ScoringEngine();
const scoreBreakdown = engine.calculateScore(agent, task);
console.log(scoreBreakdown.final_score); // 0.0-1.0
console.log(scoreBreakdown.relevance); // 相关性分数
console.log(scoreBreakdown.quality); // 质量分数
console.log(scoreBreakdown.bonus); // 新手加分
```

### 3. 选择引擎 (`selection-engine.ts`)

```typescript
const engine = new SelectionEngine((tau = 0.5)); // tau ∈ [0.3, 1.0]

// 生成竞标
const bid = engine.generateBid(agent, task, bidId, scoreBreakdown);

// 广播&收集
const { ledger, scoreBreakdowns } = engine.broadcastAndCollect(agents, task);

// Softmax sampling 选择
const winnerAgentId = engine.selectWinner(scores);

// 审计
const auditBundle = engine.generateAuditBundle(winnerBidId, bids, winnerAgent, scoreBreakdown);
```

### 4. Market门面 (`market-facade.ts`)

```typescript
const market = new MarketFacade((tau = 0.5));

// 主流程：一键拍卖
const result = await market.marketAuction(agents, task);

// 获取结果
console.log(result.winnerAgentId); // 获胜 Agent ID
console.log(result.ledger); // 完整竞标日志
console.log(result.auditBundle); // 审计产物
console.log(result.scoreBreakdowns); // 所有Agent的评分明细

// 可解释性：打印详细评分
console.log(market.getScoreExplanation(result.scoreBreakdowns.get(winnerAgentId)));
```

## 使用示例

### 基础演示

```bash
cd newide-scaffold
pnpm install
pnpm example:market-bidding-demo
```

输出示例：

```
 Market Bidding System Demo

 Task:
  ID: task_optimization_001
  Description: Optimize the core database queries...

 Running Market Auction...

 All Bids (Ranked):
  1. ALICE (Score: 88.45%)
     - Relevance: 92.10%
     - Quality: 85.20%
     - Capacity: 90.00%
     - Strategy: leverage backend-optimization + apply experience in scaling-postgres

  2. BOB (Score: 75.32%)
     ...

  3. CHARLIE (Score: 62.18%)
     ...

 Winner: ALICE
   Winning Bid ID: bid_0

 Audit Bundle:
  Task ID: task_optimization_001
  Selection Mode: weighted_sampling
  Primary Reason: strong skill-domain match + high success rate

 Winner Report:
  Why Me: best skill match
  Risk Acknowledgement: already managing multiple tasks

 Market Bidding Demo Complete!
```

### 集成到现有系统

```typescript
import { MarketFacade, type AgentProjection, type TaskSpecification } from '@/market';

// 在 Coordinator 接收到新任务时
const market = new MarketFacade();

const agentProjections = agents.map((agent) => ({
  agent_id: agent.id,
  persona_ref: agent.personaRef,
  persona: agent.getPersona(),
  skills: agent.getSkills(),
  experience: agent.getExperience(),
  metrics_ref: agent.getMetrics(),
  load_state: agent.getLoadState(),
}));

const taskSpec: TaskSpecification = {
  task_id: task.id,
  task_description: task.description,
  requirement_profile: task.requirements,
  context: task.context,
};

// 拍卖
const result = await market.marketAuction(agentProjections, taskSpec);

// 记录审计日志
await coordinator.registerAuditBundle(result.auditBundle);

// 分派给获胜者
await coordinator.assignTask(task.id, result.winnerAgentId);
```

## 测试

```bash
# 运行所有测试
pnpm test

# 运行 Market 模块测试
pnpm test market.test.ts

# Watch 模式
pnpm test -- --watch
```

## 特性

**可解释性**: 所有决策都有清晰的理由和评分明细

**可审计性**: 完整的竞标日志和审计产物

**可复现性**: 确定的评分算法和记录

**非侵入式**: 不修改现有的 Coordinator/Agent 系统

**灵活性**: 支持自定义温度参数(tau)调整选择倾向

**新手保护**: 自动为初期Agent提供加分

**动态权重**: 评分权重完全符合设计文档

## 关键特性说明

### Softmax Sampling

用于在高置信度的竞标中也保留一定的随机性（而非简单的winner-take-all），防止固定Agent垄断任务。

- `tau=0.3`: 更接近贪心选择(高分Agent更容易赢)
- `tau=0.5`: 平衡(推荐)
- `tau=1.0`: 更随机(给低分Agent更多机会)

### 新手保护

首5次任务的Agent自动获得 +0.15 的bonus，帮助新Agent获得初期机会。

### 审计追踪

每次拍卖都生成完整的 AuditBundle：

- 决策理由(为什么选这个Agent?)
- 所有竞标列表(透明对比)
- Owner报告(获胜者的自我认知)

## 下一步迭代

- [ ] 持久化竞标日志到数据库
- [ ] 与 Coordinator 事件系统集成
- [ ] 支持Agent异议机制("我不同意这个结果")
- [ ] 长期Persona趋势分析
- [ ] 竞标重试策略(Agent可重新调整策略重新投标)
