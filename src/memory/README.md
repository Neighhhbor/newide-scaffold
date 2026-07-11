# Memory 模块使用指南

Memory 是 Agent 角色与记忆系统，管理 Agent 的全生命周期数据：创建、任务执行、记忆检索、经验提取、技能晋升，以及对外查询。

---

## 目录

- [快速开始](#快速开始)
- [API key 配置](#api-key-配置)
- [端到端演示](#端到端演示)
- [核心概念](#核心概念)
- [模块分层调用链](#模块分层调用链)
  - [外部看到的完整执行流程](#外部看到的完整执行流程)
  - [Agent 内部执行流](#agent-内部执行流)
  - [Tool-calling 模式的 LLM 循环](#tool-calling-模式的-llm-循环)
  - [离线 Buffer 处理](#离线-buffer-处理)
- [对外接口一览](#对外接口一览)
  - [主要入口](#主要入口)
  - [查询门面](#查询门面)
  - [服务层函数](#服务层函数)
  - [依赖注入钩子](#依赖注入钩子)
  - [存储适配器](#存储适配器)
  - [LLM 客户端](#llm-客户端)
- [LLM 客户端架构](#llm-客户端架构)
- [配置方式](#配置方式)
- [测试](#测试)
- [常见用法示例](#常见用法示例)

---

## 快速开始

```bash
# 安装依赖
pnpm install

# 跑全部 memory 测试（纯内存，不需要 API key）
pnpm test -- --run src/memory/test

# 端到端 Agent loop 测试（需配置 API key）
pnpm test -- --run src/memory/test/integration/agent-loop-integration.test.ts

# LLM 冒烟测试
npx tsx src/memory/test/integration/api-smoke.ts
```

---

## API key 配置

需要调用真实 LLM 时，在 `src/memory/.env` 中配置（已 gitignore）：

```bash
# src/memory/.env
LLM_PROVIDER=deepseek           # 支持的 provider：deepseek / openai / anthropic
DEEPSEEK_API_KEY=sk-xxx          # 你的 API key
```

> `LiteLLMClientAdapter` 构造时自动读取此文件并映射到 AI SDK 所需的环境变量。
> 不配置 API key 时使用 `MockLlmClient`，不影响单元测试。

---

## 端到端演示

演示完整的 **竞标→派发→主动提取** 流程，使用真实 LLM 提取中文经验。

### 前置条件

按 [API key 配置](#api-key-配置) 一节配置好 `src/memory/.env`。

### 运行

```bash
npx tsx src/memory/mvp/memory-demo.ts
```

### 执行流程

| 步骤 | 操作                                      | 说明                                              |
| ---- | ----------------------------------------- | ------------------------------------------------- |
| 1    | 创建 3 个 Agent（前端/后端/运维）         | 各角色有不同 Persona 和标签                       |
| 2    | `collectCompetitionClaims()`              | 每个 Agent 自评是否参与竞标，只打印参选者         |
| 3    | `dispatchTask()` → 选中前端的 Mock Driver | 返回中文 CSS 修复报告（Flexbox 决策、产出文件等） |
| 4    | `extractBuffer()` → 真实 LLM 提取         | 提取经验 + 存 repo                                |
| 5    | `promoteExperiences()` → 真实 LLM 晋升    | 扫描 repo 晋升技能                                |
| 6    | 打印存储状态                              | 经验数、技能数、buffer 状态                       |

### 输出示例（实际结果为 LLM 实时生成）

```
=== 2. Agent 自评 — collectCompetitionClaims ===
  参选 Agent: 3 个
  ✅ role_fe — 愿意参与
  ✅ role_be — 愿意参与
  ✅ role_ops — 愿意参与

=== 3. 派发给 role_fe — dispatchTask ===
  状态: completed
  ── Mock Driver 返回 ──
  摘要: 成功修复登录页面 CSS 布局问题
  决策:
    • 布局方案选择 → Flexbox（兼容性好，一维布局更适合表单场景）
    • 移动端适配策略 → media query + rem 混合（兼顾精细控制与可维护性）

=== 4. 主动提取 + 晋升 ===
  📗 [positive] 修复登录页面CSS布局时，选择Flexbox优于Grid或浮动布局...
     置信度: 0.9  标签: css, layout, flexbox
```

### 源码路径

`src/memory/mvp/memory-demo.ts` — 可复制修改，替换 Mock Driver 数据或切换 Agent 角色。

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

## 模块分层调用链

### 外部看到的完整执行流程

```
Coordinator（或其他外部调用者）
   │
   │  AgentManager.submitTask(request)
   │  ═══════════════════════════════
   ▼
┌──────────────────────────────────────────────────┐
│  AgentManager                                    │
│                                                  │
│  ① collectCompetitionClaims(request)             │
│      └─ 对每个 Agent：createCompetitionClaim()   │
│         └─ evaluator.evaluate({ task })           │
│                                                  │
│  ② 选赢家（最高 confidence 的 participate）      │
│                                                  │
│  ③ dispatchTask(winner_role_id, request)         │
│      └─ Agent.executeTask(request)               │
│         ├─ [Tool-calling 模式]                    │
│         │   assignTask → [tick 循环] → finalize   │
│         └─ [Pipeline 模式（回退）]                 │
│             runTaskMemoryCycle()                  │
│                                                  │
│  ④ 返回 SubmitTaskResult                        │
└──────────────────────────────────────────────────┘
```

### Agent 内部执行流（Pipeline 模式）

```
Agent.runTaskMemoryCycle(memory, task, deps)
   │
   ├─ memory.getPersona()             仅元数据
   ├─ deps.planTaskInstruction(task)  产出 task_instruction
   │
   ├─ buildDriverContext(memory, task, deps.queryMemory)
   │    └─ prepareTaskContext()       检索 skills + experiences
   │       └─ deps.queryMemory()      向量 top-K + tag 补充
   │
   ├─ deps.invokeDriver(input)        调用外部 Driver（LLM）
   │    └─ DriverReturn (6字段报告)
   │
   ├─ deps.contextCleaner.clean()     清理上下文
   │    └─ AgentContextSnapshot
   │
   ├─ ingestTaskBuffer()              写 pending buffer
   │    └─ writePendingBuffer()
   │       └─ BufferRepository.saveBufferSnapshot()
   │
   ├─ processPendingBuffer()          提取经验 → 晋升技能
   │    ├─ extractor.extract()        经验提取
   │    ├─ memory.saveExperience()    经验入库
   │    ├─ promote()                  技能晋升检查
   │    └─ memory.markBufferProcessed()
   │
   └─ recordMemoryCycleTelemetry()    可选
```

### Tool-calling 模式的 LLM 循环

```
Agent.executeTask(task)  [Tool-calling 模式]
   │
   ├─ assignTask(task)
   │    ├─ buildAgentSystemPrompt()   构建 system prompt
   │    └─ memory.listSkills()        注入 skill 上下文
   │
   ├─ [tick 循环]  Agent.runLoopTick()
   │    │
   │    ├─ llm.completeWithTools()    ← LLM 自主决策
   │    │    ├─ invoke_driver 工具    调用外部 Driver
   │    │    ├─ query_memory 工具     查询记忆
   │    │    └─ ...其他工具
   │    │
   │    └─ LLM 返回 "[done]" → 退出循环
   │
   └─ finalizeLoop()
        └─ writeToBuffer()           写 pending buffer
           └─ writePendingBuffer()
```

### 离线 Buffer 处理

Tool-calling 模式下，提取和晋升不在线内执行，留给离线 Processor：

```
BufferProcessor.processPendingBuffer()
   │
   ├─ ExperienceExtractorProcessor
   │    └─ LlmExperienceExtractor.extract()     LLM 提取经验
   │         └─ 失败降级到 RuleBasedExperienceExtractor
   │
   └─ SkillPromotionProcessor
        └─ LlmSkillPromotion.promote()           LLM 晋升技能
             └─ 失败降级到 ruleBasedSkillPromotion
```

---

## 对外接口一览

### 主要入口

```typescript
import { AgentManager, type AgentTaskRequest } from '../memory';
```

| 方法                                       | 说明                                     | 返回                             |
| ------------------------------------------ | ---------------------------------------- | -------------------------------- |
| `AgentManager.create(repo, buf, options?)` | **async** 创建 Manager，预加载所有 Agent | `Promise<AgentManager>`          |
| `manager.createAgent(spec)`                | 注册新 Agent                             | `Promise<AgentHandle>`           |
| `manager.submitTask(request)`              | 竞标→选赢家→执行→写 buffer（完整流程）   | `Promise<SubmitTaskResult>`      |
| `manager.collectCompetitionClaims(task)`   | 仅竞标收集，不执行                       | `Promise<CompetitionClaimBatch>` |
| `manager.dispatchTask(role_id, task)`      | 向指定 Agent 派发任务                    | `Promise<DispatchTaskResult>`    |
| `manager.start()` / `stop()`               | 生命周期控制                             | `void`                           |
| `manager.getAgent(role_id)`                | 获取 Agent 实例                          | `Agent \| undefined`             |
| `manager.listAgentHandles()`               | 列出所有 Agent                           | `AgentHandle[]`                  |

### 查询门面

```typescript
import { RepositoryAgentBoardQuery } from '../memory';
```

| 方法                             | 说明                            |
| -------------------------------- | ------------------------------- |
| `query.listAgents()`             | 所有 Agent 卡片摘要             |
| `query.getAgent(role_id)`        | Agent 详情（Persona + Metrics） |
| `query.listSkills(role_id)`      | Agent 技能列表                  |
| `query.listExperiences(role_id)` | Agent 经验列表                  |

### 服务层函数

```typescript
import { runTaskMemoryCycle, buildDriverContext, writePendingBuffer } from '../memory';
```

| 函数                                                     | 说明                                                             | 使用场景                              |
| -------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------- |
| `runTaskMemoryCycle(memory, task, deps)`                 | 完整 Pipeline：检索→执行→写 buffer→提取→晋升                     | 直接调用记忆周期（不走 AgentManager） |
| `buildDriverContext(memory, task, queryMemory)`          | 组装 DriverContext（instruction + skills + exp）                 | 自定义执行流程时复用                  |
| `writePendingBuffer(memory, snapshot, context?)`         | 校验并写入 BufferRepository                                      | 自定义 buffer 写入                    |
| `ingestTaskBuffer(memory, ...)`                          | 写入 pending buffer + AgentContextSnapshot                       | memory-cycle 内部                     |
| `processPendingBuffer(memory, seq, ...)`                 | 提取经验 + 晋升技能 + 标记 processed                             | 离线 Processor 用                     |
| ~~**单 Agent 操作（需自行创建 memory scope）**~~         |                                                                  |                                       |
| `extractBuffer(memory, seq, llm)`                        | **仅提取**：从 buffer 提取经验并入库，不做晋升                   | 已有 memory scope 时直接调            |
| `promoteExperiences(memory, llm)`                        | **仅晋升**：扫描当前 Agent repo 中所有 eligible 经验，晋升为技能 | 已有 memory scope 时直接调            |
| ~~**指定 Agent 操作（传 role_id 即可）**~~               |                                                                  |                                       |
| `extractBufferForAgent(role_id, seq, repo, buf, llm)`    | 指定 Agent 提取 buffer                                           | 快速操作单个 Agent                    |
| `promoteExperiencesForAgent(role_id, repo, buf, llm)`    | 指定 Agent 晋升经验                                              | 快速操作单个 Agent                    |
| ~~**全 Agent 批量操作**~~                                |                                                                  |                                       |
| `extractAllBuffers(repo, buf, llm)`                      | 对所有 Agent 的每条 pending buffer 执行提取                      | 一键批量提取                          |
| `promoteAllExperiences(repo, buf, llm)`                  | 对所有 Agent 执行晋升                                            | 一键批量晋升                          |
| `prepareTaskContext(memory, task, task_id, queryMemory)` | 记忆查询 + 上下文截断                                            | memory-query 内部                     |

### 依赖注入钩子

```typescript
import type { AgentRunDeps } from '../memory';
```

| 钩子                  | 类型                               | 注入时机                    | 默认实现                          |
| --------------------- | ---------------------------------- | --------------------------- | --------------------------------- |
| `queryMemory`         | `MemoryQueryStrategy`              | `buildDriverContext()` 内   | `repositoryRetrieveMemoryForTask` |
| `planTaskInstruction` | `TaskInstructionPlanner`           | `runTaskMemoryCycle()` 内   | `mockPlanTaskInstruction`         |
| `invokeDriver`        | `(input) => Promise<DriverReturn>` | `runTaskMemoryCycle()` 内   | `invokeMockDriver`                |
| `extractor`           | `ExperienceExtractor`              | `processPendingBuffer()` 内 | `RuleBasedExperienceExtractor`    |
| `promote`             | `SkillPromotionHandler`            | `processPendingBuffer()` 内 | `ruleBasedSkillPromotion`         |
| `contextCleaner`      | `AgentContextCleaner`              | `runTaskMemoryCycle()` 内   | `NullContextCleaner`              |

### 存储适配器

```typescript
import { InMemoryRepository, PgMemoryRepository, FileBufferRepository } from '../memory';
```

| 适配器              | 存什么                                 | 生产                       | 测试                       |
| ------------------- | -------------------------------------- | -------------------------- | -------------------------- |
| `*Repository`       | 长期记忆（Persona/Skills/Experiences） | `PgMemoryRepository`       | `InMemoryRepository`       |
| `*BufferRepository` | buffer 队列                            | `FileBufferRepository`     | `InMemoryBufferRepository` |
| `AgentMemoryScope`  | Agent 绑定读写面                       | `createAgentMemoryScope()` | 同上                       |

### LLM 客户端

```typescript
import { LiteLLMClientAdapter, MockLlmClient, type LlmClient } from '../memory';
```

| 实现                   | 说明                                                  | 需 API key |
| ---------------------- | ----------------------------------------------------- | ---------- |
| `LiteLLMClientAdapter` | **生产** — 基于 Vercel AI SDK，从 `.env` 和 YAML 配置 | ✅         |
| `MockLlmClient`        | **测试** — 预设响应 mock                              | ❌         |

---

## LLM 客户端架构

### 两层设计

```
你的代码（LlmExperienceExtractor / LlmTaskInstructionPlanner / ...）
       │
       ▼  LlmClient 接口（ports/llm-client.ts）
 ┌───────────────────────┐
 │  LiteLLMClientAdapter │    ← 实现 LlmClient
 └──────┬────────────────┘
        │  包装
 ┌───────────────┐
 │  LiteLLMClient│    ← src/litellm/ 通用 LLM 服务
 └──────┬────────┘
        │  AI SDK
 ┌──────────────┐
 │ @ai-sdk/*    │    ← 支持 DeepSeek / OpenAI / Anthropic
 └──────────────┘
```

### 支持的 Provider

| Provider  | .env 变量           | YAML 配置                                      |
| --------- | ------------------- | ---------------------------------------------- |
| DeepSeek  | `DEEPSEEK_API_KEY`  | `provider: openai, model: deepseek-chat`       |
| OpenAI    | `OPENAI_API_KEY`    | `provider: openai, model: gpt-4o-mini`         |
| Anthropic | `ANTHROPIC_API_KEY` | `provider: anthropic, model: claude-3-5-haiku` |

---

## 配置方式

```text
src/memory/.env              ← API key（已 gitignore）
src/litellm/config/          ← 模型选择 / 超时 / temperature
  ├── defaults.yaml            全局默认值
  ├── profiles.yaml            可复用模型 Profile
  └── memory-query.yaml        memory 模块任务配置
```

---

## 测试

```bash
# 单元测试（纯内存 mock，不需要 API key）
pnpm test -- --run src/memory/test

# 单文件
pnpm test -- --run src/memory/test/<file>.test.ts

# 端到端 Agent loop 测试（需 API key）
pnpm test -- --run src/memory/test/integration/agent-loop-integration.test.ts

# LLM 冒烟测试（需 API key）
npx tsx src/memory/test/integration/api-smoke.ts
```

28 个测试文件，228 个测试用例。

---

## 常见用法示例

### 最简启动（全 mock）

```typescript
import { AgentManager, InMemoryRepository, InMemoryBufferRepository } from '../memory';

const repo = new InMemoryRepository();
const buf = new InMemoryBufferRepository();
const manager = await AgentManager.create(repo, buf);

await manager.createAgent({ role_id: 'agent_1', name: 'Test Agent', tags: [] });
```

### 使用 LLM 提取

```typescript
import {
  AgentManager,
  InMemoryRepository,
  InMemoryBufferRepository,
  createDefaultLlmAgentRunDeps,
} from '../memory';

const manager = await AgentManager.create(repo, buf, {
  deps: createDefaultLlmAgentRunDeps(),
});
```

### 接入真实 Driver

```typescript
import {
  AgentManager,
  InMemoryRepository,
  InMemoryBufferRepository,
  createDriverAdapterDeps,
} from '../memory';

const manager = await AgentManager.create(repo, buf, {
  deps: createDriverAdapterDeps({ driverCommand: 'gemini' }),
});
```

### 纯竞标（不执行）

```typescript
const batch = await manager.collectCompetitionClaims(task);
const winner = batch.claims.find((c) => c.decision === 'participate');
if (winner) await manager.dispatchTask(winner.role_id, task);
```

### 主动提取（单 Agent）

```typescript
// 方式 A：已有 memory scope
const memory = createAgentMemoryScope(repo, buf, 'role_fe');
const seqs = await memory.listPendingBufferSeqs();
for (const seq of seqs) {
  const extraction = await extractBuffer(memory, seq, llm);
}

// 方式 B：直接传 role_id（更简洁）
const extraction = await extractBufferForAgent('role_fe', seq, repo, buf, llm);
```

### 主动晋升（单 Agent）

```typescript
// 方式 A
const memory = createAgentMemoryScope(repo, buf, 'role_fe');
const outcomes = await promoteExperiences(memory, llm);

// 方式 B
const outcomes = await promoteExperiencesForAgent('role_fe', repo, buf, llm);
```

### 一键全 Agent 批量提取 + 晋升

```typescript
import { extractAllBuffers, promoteAllExperiences } from '../memory';

// 所有 Agent 的所有 pending buffer 提取经验
const allExtractions = await extractAllBuffers(repo, buf, llm);

// 所有 Agent 的 eligible 经验晋升技能
const allPromotions = await promoteAllExperiences(repo, buf, llm);
```
