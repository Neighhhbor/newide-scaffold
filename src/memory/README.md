# Memory 模块使用指南

Memory 是 Agent 角色与记忆系统，管理 Agent 的全生命周期数据：创建、任务执行、记忆检索、经验提取、技能晋升，以及对外查询。

---

## 快速开始

```bash
# 安装依赖
pnpm install

# 跑全部 memory 测试
pnpm test -- --run src/memory/test

# 端到端演示
npx tsx src/memory/mvp/memory-demo.ts
```

---

## 核心概念

| 概念                | 说明                                                   |
| ------------------- | ------------------------------------------------------ |
| **Agent**           | 一个独立角色，拥有自己的 Persona、技能、经验和任务能力 |
| **Persona**         | Agent 的能力画像，由 LLM 定期归纳生成                  |
| **Experience**      | 任务成功后反思提取的结构化知识（正经验 / 负经验）      |
| **Skill**           | 高置信度经验晋升而成的可复用能力单元                   |
| **Buffer**          | 任务后原始的 Driver 报告暂存区，是经验提取的原材料     |
| **AgentManager**    | 管理 Agent 生命周期的 Boss，负责创建 Agent、竞标派单   |
| **AgentBoardQuery** | **对外只读查询门面**，供 BFF / 前端查看 Agent 数据     |

---

## 设计模式

### 存储与 Agent 分离

`MemoryRepository`（仓储）只负责 Agent 数据的持久化读写，不包含任何业务逻辑。Agent 本身是纯状态机（`bid → runOnce`），不直接持有仓储引用，通过 `AgentMemoryScope`（绑定 `role_id` 的仓储视图）访问自己的数据，实现存储与实体的解耦。

```
MemoryRepository  ←  仓储，只作存取
       ↑
AgentMemoryScope  ←  绑定 role_id 的访问门面
       ↑
      Agent       ←  纯状态机，不感知存储细节
```

### Manager 依赖仓储查询

`AgentManager` 是上层编排者，依赖 `MemoryRepository` 完成 Agent 的创建、查找、派单等操作。Manager 不直接操作数据库，而是通过 Port 接口依赖倒置：

```
AgentManager ──→ MemoryRepository (port)
                      │
          ┌───────────┼───────────┐
          ▼           ▼           ▼
   InMemoryRepo  PgMemoryRepo   （其他实现）
```

外层注册具体实现，Manager 只依赖接口，符合依赖倒置原则。

### 外部查询也依赖仓储

`AgentBoardQuery` 是对外只读查询门面，同样依赖 `MemoryRepository` 来聚合数据。无论是 Manager 的内部编排还是 BoardQuery 的外部展示，都复用同一套仓储接口，保证数据一致：

```
AgentManager  AgentBoardQuery
      │              │
      └──────┬───────┘
             ▼
   MemoryRepository (port)
```

这种模式让新增查询场景只需组合现有 port，不需要重复写存储逻辑。

---

## 配置存储

Memory 使用两个存储后端：

```typescript
import {
  InMemoryRepository, // 长期记忆（Persona / Skills / Experiences）
  InMemoryBufferRepository, // 缓冲区队列
} from '../memory';

const repository = new InMemoryRepository();
const bufferRepository = new InMemoryBufferRepository();
```

开发/测试用 `InMemory`，生产可替换 `PgMemoryRepository` + `FileBufferRepository`：

```typescript
import { PgMemoryRepository, FileBufferRepository } from '../memory';

const pg = new PgMemoryRepository({ pool });
const file = new FileBufferRepository({ rootPath: './agent-data' });
```

---

## 创建 Agent

```typescript
import { AgentManager, InMemoryRepository, InMemoryBufferRepository } from '../memory';

const repo = new InMemoryRepository();
const buf = new InMemoryBufferRepository();
const manager = AgentManager.create(repo, buf);

// 创建 Agent（指定 role_id、显示名、可选标签）
await manager.createAgent({
  role_id: 'role_fe_engineer',
  name: 'Frontend Engineer',
  tags: ['react', 'typescript', 'css'],
});
```

---

## 执行任务

```typescript
// 派单：竞标 → 选赢家 → 执行 → 写 buffer → 提取经验 → 晋升
const result = await manager.submitTask({
  spec: '修复登录页面的 CSS 布局问题',
  task_id: 'task_001',
  call_id: 'call_001',
  source_driver: 'code-driver',
});

console.log('中标 Agent:', result.winner_role_id);
console.log('提取经验数:', result.cycle.extraction.experiences.length);
```

返回的 `MemoryCycleResult` 包含：

| 字段              | 内容                               |
| ----------------- | ---------------------------------- |
| `agent_id`        | 执行任务的 Agent                   |
| `driver_context`  | 下发给 Driver 的完整上下文         |
| `buffer_snapshot` | 写入 buffer 的 Driver 6 字段报告   |
| `extraction`      | 经验提取结果（新建/更新/晋升数量） |
| `promotion`       | 技能晋升检查结果                   |

---

## 查询 Agent 数据

`AgentBoardQuery` 是**对外只读查询门面**，供 BFF / 前端使用。

```typescript
import { RepositoryAgentBoardQuery, InMemoryRepository } from '../memory';

const repo = new InMemoryRepository();
const query = new RepositoryAgentBoardQuery(repo);
```

### 列出所有 Agent（卡片摘要）

```typescript
const agents = await query.listAgents();
// [
//   {
//     role_id: 'role_fe_engineer',
//     name: 'Frontend Engineer',
//     status: 'created',
//     tags: ['react', 'typescript', 'css'],
//     skill_count: 3,
//     experience_count: 12,
//     persona_summary: '擅长 React 与 TypeScript 开发...',
//   },
// ]
```

### 查看 Agent 详情

```typescript
const detail = await query.getAgent('role_fe_engineer');
// {
//   role_id: 'role_fe_engineer',
//   name: 'Frontend Engineer',
//   tags: ['react', 'typescript', 'css'],
//   skill_count: 3,
//   experience_count: 12,
//   persona: { /* 完整 PersonaDef */ },
//   metrics: {
//     raw: {   /* AgentMetrics —— 累积原始指标 */
//       total_tasks: 20,
//       tasks_succeeded: 15,
//       skill_count: 3,
//       experience_count: 12,
//       ...
//     },
//     derived: { /* DerivedMetrics —— 实时计算 */
//       success_rate: 0.75,
//       bid_win_rate: 0.6,
//       activity_score: 0.92,
//       ...
//     },
//   },
//   created_at: '2025-01-01T00:00:00.000Z',
// }
```

### 查看技能列表（按需加载）

```typescript
const skills = await query.listSkills('role_fe_engineer');
// 返回 SkillView，不包含 description_embedding
```

### 查看经验列表（按需加载）

```typescript
const experiences = await query.listExperiences('role_fe_engineer');
// 返回 ExperienceView，不包含 description_embedding 与 linked_negative_exp
```

---

## 自定义任务流程（依赖注入）

`Agent` 的工作依赖可通过 `AgentRunDeps` 注入替换：

```typescript
import { AgentManager } from '../memory';
import { repositoryRetrieveMemoryForTask } from '../memory';
import { ruleBasedSkillPromotion } from '../memory';

const manager = AgentManager.create(repo, buf, {
  deps: {
    queryMemory: repositoryRetrieveMemoryForTask, // 向量 + tag 检索
    planTaskInstruction: myPlanner, // 自定义指令规划
    invokeDriver: myDriver, // 真实的 Driver 调用
    extractor: myExtractor, // 自定义经验提取器
    promote: ruleBasedSkillPromotion, // 规则版晋升
    contextCleaner: myCleaner, // 上下文清理
  },
});
```

不传 `deps` 时默认使用 `mvp/default-agent-run-deps.ts`（全 mock）。

---

## 测试

```bash
# memory 全部测试
pnpm test -- --run src/memory/test

# 单文件
pnpm test -- --run src/memory/test/agent-board-query.test.ts
```

---

## 跨模块契约

给 Coordinator 使用的任务前上下文装配：

```typescript
import { RepositoryMemoryProvider } from '../memory';

const provider = new RepositoryMemoryProvider(repository);
const pack = await provider.buildContextPack({
  task_id: 'task_001',
  role_profile_ref: 'role_fe_engineer',
});
```
