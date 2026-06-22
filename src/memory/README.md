# Memory 模块（方向 B）

Agent 角色与记忆系统：管理 Persona、Experience、Skill、任务前后上下文装配，以及任务后的 buffer 原材料暂存与经验提取。

**字段级契约**见 [`docs/方向B：Agent角色与记忆系统——Spec.md`](./docs/方向B：Agent角色与记忆系统——Spec.md)。

---

## 快速开始

```bash
# 端到端演示（Memory 内部独立链路）
npx tsx src/memory/mvp/memory-demo.ts

# 自动化测试
npx vitest run src/memory/mvp/memory-input.test.ts
```

```typescript
import { AgentManager, InMemoryRepository } from '../memory';

const repository = new InMemoryRepository();
const manager = AgentManager.create(repository);

await manager.createAgent({ role_id: 'role_a', name: 'Agent A' });
manager.start();

const { cycle } = await manager.submitTask({
  spec: 'Do something.',
  task_id: 'task_001',
  call_id: 'call_001',
  scenario: 'promotion_ready', // 可选：控制 mock 晋升分支
});

console.log(cycle.buffer_snapshot.task_id, cycle.extraction.experiences.length);
```

---

## 两条对外链路（不要混用）

| 链路 | 入口 | 谁用 | 阶段 |
|------|------|------|------|
| **Coordinator 契约** | `MockMemoryProvider.buildContextPack()` | `coordinator/basic-flow` | 任务**开始前**装配 ContextPack |
| **Agent 内部编排** | `AgentManager.submitTask()` → `Agent.runOnce()` | Memory 演示 / 未来 Coordinator 任务后回调 | 任务**执行后**写 buffer、提取经验 |

当前 **basic-flow 只走第一条**；第二条在 `memory-demo` 与测试中跑通，尚未接入 Coordinator。

---

## 核心架构

```
┌─────────────────────────────────────────────────────────┐
│  contract.ts          Coordinator → ContextPack       │
│  mock-memory.ts       MockMemoryProvider（v0 demo）      │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  AgentManager（Boss）                                    │
│    createAgent / submitTask / 竞标                       │
│         │                                                │
│         ▼                                                │
│  Agent（员工）+ AgentMemoryScope（绑定 role_id）           │
│    runOnce → runTaskMemoryCycle                          │
│         │                                                │
│         ├─ memory-query      任务前查记忆（mock 策略可注入）│
│         ├─ mock Driver       生成 DriverReturn           │
│         ├─ buffer-writer     写 pending buffer           │
│         └─ memory-cycle      提取 → 入库 → 晋升 → processed│
│         │                                                │
│         ▼                                                │
│  MemoryRepository / InMemoryRepository（按 role_id 隔离）  │
└─────────────────────────────────────────────────────────┘
```

**存储原则**：所有 Agent 共享一个 `MemoryRepository` 实例；数据按 `role_id` 隔离。Agent 通过 `AgentMemoryScope` 访问自己的记忆，不直接传 `role_id`。

---

## 目录结构

```
src/memory/
├── README.md                 # 本文件
├── index.ts                  # 统一导出
├── schemas.ts                # Spec §3 持久化实体（Zod）
├── types.ts                  # 流程组合类型（MemoryCycleResult 等）
├── contract.ts               # 与 Coordinator 的 ContextPack 契约
├── agent-types.ts            # Agent 运行时 DTO（AgentTaskRequest）
├── mock-memory.ts            # MemoryProvider mock（给 basic-flow）
│
├── ports/                    # 接口契约（无实现）
│   ├── memory-repository.ts
│   ├── agent-memory-scope.ts
│   ├── experience-extractor.ts
│   ├── agent-context-cleaner.ts
│   └── …                     # embedding、skill-market、buffer-trigger 等（待实现）
│
├── adapters/                 # 存储与作用域实现
│   ├── in-memory-repository.ts
│   └── agent-memory-scope.ts
│
├── services/                 # 正式编排（长期保留）
│   ├── memory-query.ts       # 任务前检索 + ContextPack
│   ├── buffer-writer.ts      # 写 pending buffer
│   └── memory-cycle.ts       # ingest / process / 全周期
│
├── runtime/                  # Agent 运行时
│   ├── agent.ts
│   ├── agent-manager.ts
│   └── agent-run-deps.ts     # 可注入依赖（检索/Driver/提取/晋升）
│
├── mvp/                      # mock 与演示（可整包删除）
│   ├── memory-demo.ts
│   ├── memory-input.test.ts
│   ├── default-agent-run-deps.ts
│   ├── services/             # mock 检索、mock 晋升
│   └── adapters/             # mock Driver、mock 提取器
│
└── docs/                     # Spec 与旧版导读
```

---

## 关键类型

| 类型 | 文件 | 说明 |
|------|------|------|
| `BufferSnapshot` | `schemas.ts` | Driver 6 字段报告 + 任务元数据（pending 原材料） |
| `AgentContextSnapshot` | `schemas.ts` | 顶层 Agent 清理后上下文（与 Buffer 成对） |
| `ExperienceRecord` / `SkillRecord` | `schemas.ts` | 长期记忆 |
| `AgentHandle` | `schemas.ts` | Agent 聚合根（档案视图） |
| `ContextPack` | `contract.ts` | Coordinator 任务前上下文包 |
| `AgentTaskRequest` | `agent-types.ts` | Agent 任务派发 DTO |
| `MemoryCycleResult` | `types.ts` | `runOnce` 完整返回 |

---

## Buffer 与记忆生命周期（MVP）

```
submitTask(AgentTaskRequest)
  → mock 检索（prepareTaskContext）
  → mock Driver（DriverReturn）
  → ingestTaskBuffer（写入 pending：BufferSnapshot + AgentContextSnapshot）
  → processPendingBuffer（mock 提取 Experience → 可选 mock 晋升 Skill → markBufferProcessed）
```

- **pending**：临时工作记忆（当前为内存 Map，无物理目录）
- **experiences / skills**：提取后写入 `InMemoryRepository`（mock 长期存储）
- MVP **同步**执行 ingest + process；`ingestTaskBuffer` / `processPendingBuffer` 已拆分，便于后续接 `BufferTriggerPolicy` 异步批处理

按 `task_id` / `call_id` 查 pending：组合 `listPendingBufferSeqs` + `getPendingBuffer`（无专用 find API）。全周期跑完后 pending 已清空，可从 `cycle.buffer_snapshot` 或 `listExperiences` 验证。

---

## 依赖注入（AgentRunDeps）

`Agent` 构造函数第二参数可注入运行依赖，默认使用 `mvp/default-agent-run-deps.ts`：

```typescript
new Agent(memory, {
  queryMemory: mockRetrieveMemoryForTask,  // 可换真实检索
  invokeDriver: invokeMockDriver,
  extractor: new MockExperienceExtractor(),
  promote: runMockSkillPromotion,
});
```

替换 mock 时只改 deps，不改 `services/` 与 `Agent` 骨架。

---

## 导出与使用边界

**推荐从 `index.ts` 导入**（或 `from '../memory'`）。

| 对外给其他方向 | 模块内 / 演示 |
|----------------|---------------|
| `MockMemoryProvider`、`ContextPack` | `AgentManager`、`InMemoryRepository` |
| `schemas`、`types` | `runTaskMemoryCycle`、`defaultMvpAgentRunDeps` |
| 未来 `MemoryReadAPI`（§6，未实现） | `mvp/*` |

**不要**让 Coordinator 直接调用 `MemoryRepository` 写 buffer；任务后输入应走 `AgentManager.submitTask`（或后续专门门面）。

---

## 当前完成度（MVP）

| 能力 | 状态 |
|------|------|
| Agent 创建 / 派任务 / runOnce 全周期 | ✅ mock 跑通 |
| pending buffer 写入（内存） | ✅ |
| mock 经验提取与技能晋升 | ✅ |
| 与 `coordinator/basic-flow` 打通 | ❌ |
| 文件系统 / PostgreSQL 存储 | ❌ |
| 向量检索、技能市场、异步 buffer 批处理 | ❌ 仅有 ports |

---

## 相关文档

- [方向 B Spec（字段定义）](./docs/方向B：Agent角色与记忆系统——Spec.md)
- [旧版代码导读](./docs/README.md)（部分章节可能过时，以本 README 与源码为准）
