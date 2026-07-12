# 方向B：Agent 角色与记忆系统 — RFC

# **Agent 角色与记忆系统 — RFC**

## **1\. 动机与问题定义**

### **1\.1 一个叙事起点**

Agent Alpha 是一个刚创建的白板 Agent。它被投入到一个自由竞争的任务市场——Boss 发布任务，所有 Agent 自主评估自身竞争力，通过加权抽签认领。

Alpha 接到的第一个任务是"优化 shopping\-cart 的安全性能"。它没有任何经验可以参考，全靠自主探索完成。用户评分"完全解决"。

这次任务的过程留在 Alpha 的记忆里。下一次 Boss 发布"检查 payment\-api 的 OWASP Top 10 合规"时，Alpha 检索到了上次的经验——它比别的白板 Agent 多了一点竞争力，中了标。这次也成功了。

37 次安全类任务之后，Alpha 的某些经验已经被反复验证了 10 次以上，置信度超过了 0\.95——这些经验晋升为技能（Skills）。系统的离线 LLM 归纳了它的所有经验和技能，生成了一份 Persona："专长 Web 应用安全加固，擅长 SQL 注入 / XSS / SSRF 修复"。现在 Alpha 不是随机接任务了——它知道自己擅长什么，任务市场也知道它的估值。

Alpha 还会遇到失败——把 payment\-svc 的方案套用到 legacy\-reporting 模块时，旧版 ORM 不兼容。这生成了一条负经验："旧版 ORM 参数化改造前需验证驱动兼容性"。之后每次检索到那条 SQL 注入正经验，这条负经验也会一起出现——正经验告诉 Alpha 怎么做，负经验告诉它什么条件下得小心。

当 Alpha 积累了 27 个安全类技能，覆盖代码层、基础设施、合规审计三个差异明显的子方向时，系统检测到技能向量聚类分离——Alpha 分裂为 Alpha\-Code（代码层安全）、Alpha\-Infra（基础设施安全）和 Alpha\-Audit（合规审计）。

这就是本系统要达成的目标：**Agent 不是被预设角色定义的，而是在任务市场的自由竞争中，通过记忆沉淀、经验反思、技能晋升，逐渐成长为有辨识度的角色。**

### **1\.2 核心问题**

当前 Agent 系统在设计上面临以下五个结构性问题：

| 问题                 | 表现                                                                                |
| -------------------- | ----------------------------------------------------------------------------------- |
| **无跨任务成长**     | Agent 每次执行任务从零开始。上一次成功学到的方案、失败踩过的坑，下一次全部清零      |
| **知识不可复用**     | Agent A 花了 20 次任务掌握的技能，Agent B 无法继承。每个 Agent 在孤岛上重新发明轮子 |
| **角色无定义**       | Agent 不知道自己擅长什么、不擅长什么，任务认领靠随机。用户也很难判断该把任务交给谁  |
| **记忆随上下文消失** | 单次任务结束后，决策过程、失败原因、关键假设全部随 context window 关闭而消失        |
| **无生命周期管理**   | Agent 永不进化、永不分裂、永不淘汰。无论成长方向走偏还是长期闲置，系统无感知        |

### **1\.3 本系统的位置**

本系统关注 **Agent 的内部能力建模**——Agent 如何记忆、如何成长、如何分化、如何淘汰。它不涉及：

- 任务的调度和分配策略（那是任务市场的事）

- Agent 间通信协议（那是方向 C 的 A2A / Scaffold 层的事）

- 前端 UI 或用户体验

本系统承接方向 C 的长程协调能力（checkpoint / resume / ask\_help / escalate），为 Agent 在协调之外提供了"自身变强"的进化机制。

## **2\. 设计目标与非目标**

### **2\.1 设计目标**

```Plain Text
G1: Agent 在每次任务后保留经验，下次同类任务竞争力增强
G2: 经过充分验证的经验可以晋升为技能，跨 Agent 复用
G3: 系统能为每个 Agent 归纳出一份当前的 Persona，用于任务认领自评和用户了解
G4: Agent 能按自身能力分布自然分裂为更专注的子 Agent
G5: 成长方向走偏或长期闲置的 Agent 能被系统识别并退休
```

### **2\.2 非目标**

```Plain Text
N1: 不是任务调度系统——不决定"谁来做这个任务"
N2: 不是 Agent 间通信协议——不解决"Agent 之间怎么传递消息"
N3: 不定义用户记忆（user memory）、项目记忆（project memory）或团队约定
     ——这些属于 Collaboration Memory，后续在独立 RFC 中定义
N4: 不是完整的 Agent 运行时——Driver 的执行环境由外部工具（Claude Code CLI 等）提供
```

## **3\. 架构总览**

```Plain Text
┌─────────────────────────┐
                            │     任务市场 (外部)        │
                            │  Boss 发布任务 → Agent 竞争 │
                            └───────────┬─────────────┘
                                        │ 认领
                                        ▼
┌───────────────────────────────────────────────────────────────────┐
│                         Agent 内部                                  │
│                                                                    │
│   ┌─────────────────────────────────────┐                         │
│   │    顶层 LLM (prompt 组装 + 经验提取)   │                         │
│   │     context 仅含：                    │                         │
│   │     Persona + 任务描述 + 对话记录      │                         │
│   │     ↕ 上下文压缩（摘要/滑动窗口）       │                         │
│   │     **不参与经验提取**                 │                         │
│   │                                    │                         │
│   │  在线阶段 (每任务一次):               │                         │
│   │  · 检索 Experience / Skills         │                         │
│   │  · 组装 prompt → 下发 Driver         │                         │
│   │  · 检视 Driver 返回 → 更新 Metrics   │                         │
│   │                                    │                         │
│   │  离线阶段 (缓冲区触发/定时触发):       │                         │
│   │  · 消费 Driver 报告 → 提取 Experience │                         │
│   │  · 更新置信度                        │                         │
│   │  · 触发 Skill 晋升检查               │                         │
│   └──────┬───────────────────────────┬──┘                         │
│          │ prompt (组装)              │ 返回(6字段)                  │
│          │  ① 项目全局信息 ← 存储层     │   ↓                        │
│          │  ② 任务描述 ← top context  │   ┌─────────────────────┐ │
│          │  ③ 经验 content ← 存储层    │   │ 缓冲区 (out-of-context)│ │
│          │  ④ 格式模板 ← 系统固定      │   │ Driver 报告暂存       │ │
│          ▼                             │   │ 唯一经验来源          │ │
│   ┌─────────────────────────────────────┐ └─────────┬───────────┘ │
│   │         Driver (可插拔)               │───────────┘              │
│   │  · Claude Code CLI / Gemini CLI / ...│                           │
│   │  · 接收 prompt，执行编写/调试         │                           │
│   │  · 返回产物 + 决策点 + 假设           │                           │
│   └─────────────────────────────────────┘                           │
│                                                                      │
│   ┌─────────────────────────────────────────────────┐                │
│   │      存储层                                      │                │
│   │  · 索引层 (向量库): description_embedding         │                │
│   │  · 载荷层 (JSON): content + metadata              │                │
│   │  · 项目全局信息: 直接进入 Driver prompt，不经过 top│                │
│   └─────────────────────────────────────────────────┘                │
└───────────────────────────────────────────────────────────────────┘
```

角色模型五字段的关系：

```Plain Text
短期记忆                              长期记忆
  (原始材料)                            (结构化知识)

  Out-of-context   顶层 LLM 离线提取    Experience  ──→ Skills ──→ Persona
  (缓冲区/原材料) ──────────────────→ (置信度升降)    (置信度>0.95)  (LLM归纳)
                                            │
                                            │ 失败 → 置信度下降
                                            ▼
                                      负经验关联
                                   (linked_negative_exp)
```

In\-context（工作记忆）随任务加载和移出，不直接出现在此晋升链路中——它是 Out\-of\-context 的来源，而晋升管道从短记忆中未经结构的原材料（Out\-of\-context）起步，终点是长期记忆中经过萃取的结构化知识。

## **4\. Agent 角色模型**

每个 Agent 包含 5 个核心字段。其中 Skills 和 Experience 的分层是整个模型的基础——分属不同的信任等级和共享范围。

### **4\.1 Persona（人物画像）**

#### 定义

Persona 是在 Agent 成长过程中，系统定期对其经验库和技能声明进行 LLM 归纳后生成的结果。它不是预设的角色定义，而是随时间演化的**当前能力快照**。

```Plain Text
示例（Agent Alpha，37 次安全类任务后）：
─────────────────────────────────
专长领域：Web 应用安全加固
掌握技能：OWASP 漏洞检测、WAF 配置、鉴权方案审计
经验覆盖：SQL 注入 / XSS / SSRF / 权限绕过
近期表现：安全类任务成功率 92%，共完成 37 次
注意：擅长代码层安全，OS 层安全经验尚缺
```

Persona 服务于两个方向：

\- **对外（用户）**：帮助用户快速了解该 Agent 擅长什么，决定是否手动指定

\- **对内（Agent）**：让 Agent 知道自己擅长什么，辅助任务认领时的竞争力自评

Persona 在顶层 LLM context 中永久常驻，但本身会被定期重新归纳和更新。每次归纳后版本化，旧版本保留为历史快照。

#### 归纳 Persona 的触发规则

```Plain Text
Persona 重新归纳触发条件（满足任一）：

1. 技能数变化 ≥ Δ：
   - Skills 新增 ≥ 3 个 → 触发（能力方向扩展）
   - Skills 减少 ≥ 2 个（分裂转移）→ 触发（能力方向收窄）

2. 经验分布漂移：
   - 最近 N 条经验的 tags 分布与现有 Persona 的领域描述
     余弦相似度 < 0.6 → 触发（Agent 的成长方向变了）

3. 定期触发：
   - 距上次归纳 ≥ 7 天 AND 有新经验产生
   - 或距上次归纳 ≥ 30 天（即使没有新经验，也要刷新"近期表现"）
```

### **4\.2 Skills（技能）**

Skills 是**经过验证、趋于稳定的可复用能力单元**，由高置信度经验晋升而来。

| 属性          | 经验（Experience） | 技能（Skill）               |
| ------------- | ------------------ | --------------------------- |
| 来源          | Agent 自行反思产生 | 经验晋升（置信度 \> 0\.95） |
| 审核          | 无需               | 需要（自动化或人工）        |
| 跨 Agent 复用 | 不可（绑定 Agent） | 可（进入技能市场）          |
| 版本控制      | 无                 | 有                          |
| 稳定性        | 持续变动           | 相对稳定                    |

技能声明直接影响竞争力计算：即使本次任务的具体场景在经验库中没有完全匹配，技能声明也能为 Agent 提供一个高于 baseline 的基准竞争力。

### **4\.3 Experience（经验）**

Experience 是 Agent 在每次任务完成后，通过离线 LLM 反思提取的结构化知识记录。每条经验包含：

- 触发场景

- 方案摘要

- 关键决策（选项、选择、理由）

- 结果（成功/失败）

- 置信度（0\.0 \- 1\.0）

经验分为正经验和负经验：

\- **正经验**：成功的方案复用 → 置信度上升 → 未来同类任务竞争力增强

\- **负经验**：失败教训 → 关联到被引用的经验记录上 → 后续检索时作为警告同时命中

负经验是经验质量控制的关键机制——它不是删除旧经验，而是记录"这条经验在什么条件下会失败"，为旧经验补充适用边界。

### **4\.4 为什么区分 Skills 和 Experience**

两者都是 Agent 从任务中积累的知识，但分属两个不同的信任等级和共享范围。

**1\. 保护 Agent 的探索空间**

经验是低门槛的——单次任务后就能生成，置信度从 0\.3 起步。Agent 可以大胆尝试新方案，失败了也只是经验置信度下调，不会污染技能库。如果把所有经验直接当技能对待，每个失败的尝试都会影响其他 Agent 的判断。

**2\. 跨 Agent 传递的是可靠知识，不是半成品**

技能市场的意义是让 Agent Beta 学到 Agent Alpha 验证过的能力。但前提是这个技能必须是可靠的——Beta 信任的是"经过 10 次验证"的结论，而不是 Alpha 某次任务后的初步总结。Experience → Skills 的晋升门槛（置信度 \> 0\.95）就是这道质量闸门。

### 4\.5 Skill 和 Experience 的具体设计

#### 提取

经验提取 Prompt 设计遵循以下原则：

**原则 1：执行者无关性。** 提取 LLM 从 Driver 的结构化报告中萃取经验，不从自己的行为中学习。这与 Claude Code 的 Coordinator 模式一致——Coordinator 自己不写代码，只综合 Worker 的结果。

**原则 2：保留"决策"而非"操作"。** Driver 做了哪些具体操作（调了什么 API、写了哪些文件）不重要，重要的是 Driver 在岔路口做了什么选择、为什么这样选。类似 Claude Code Auto\-Memory 的规则——不保存可从代码库重新派生的内容。

**原则 3：提取的是可迁移模式，不是项目特定记录。** 经验必须抹去项目名、文件名、driver 名。Claude Code 的 consolidation prompt 要求"将相对日期转换为绝对日期"——同理，经验提取要求"将项目特定信息转换为领域通用模式"。

**原则 4：负经验关联到正经验。** 失败教训不单独存储，而是挂载到被引用的正经验上。这与 Claude Code Auto\-Memory 的"删除被证伪的事实——在源头修复"原则一致。

#### 触发及去重规则

**提取触发条件（三层门控，由廉到贵）：**

```Markdown
提取触发条件（三层门控，由廉到贵）：

1. 时间门控：
   - 距上次提取 ≥ N 小时（默认 6 小时，可配置）
   - 对于低活跃 Agent，延长间隔（节省计算资源）

2. 缓冲区门控：
   - 缓冲区中 Driver 报告数量 ≥ M 条（默认 3 条）
   - 或存在一条 effectiveness="ineffective" 的报告（负经验需尽快处理）
   - 或存在一条 user_rating="未解决" 的报告（高价值失败信号）

3. 锁门控：
   - 没有其他提取进程正在运行
   - 使用文件锁（类似 .consolidate-lock）+ PID 存活检查
   - 1 小时超时自动释放
```

**去重机制：**

```Plain Text
去重机制：
- 提取前检索最近 N 条经验的 description
- 新经验与已有经验的 description embedding 余弦相似度 > 0.85 时：
  → 不是创建新经验，而是更新已有经验的 content 和 confidence
  → 记录在 confidence_history 中
```

### **4\.****6**** Memory（记忆）**

Memory 是 Agent 的记忆系统。In\-context（工作记忆）只做上下文压缩管理，不参与经验提取。Out\-of\-context（缓冲区）仅接收 Driver 的 6 字段返回报告，是经验提取的唯一原材料来源。长期记忆（Experience \+ Skills \+ Persona）是经过顶层 LLM（离线模式）反思提取后的结构化知识。详细设计见第 6 节。

### **4\.****7**** Metrics（绩效指标）**

Metrics 是该 Agent 的工作量化记录，包含任务完成率、成功率、Skills 数量、token 开销等。

Metrics 的唯一用途是辅助竞争力估值——**不做排名、不做惩罚、不做歧视**。竞争力只通过加权抽签体现（而非排序最高的直接接任务），且仅在抽签时计算、不持久化。

详见第 14 节。

## **5\. 能力晋升管道**

Agent 的能力积累遵循一条从临时到固化的晋升路径：

```Plain Text
In-context                         Out-of-context ──→ Experience ──→ Skills ──→ Persona
(上下文压缩，不参与经验提取)           (Driver 报告/唯一来源) (反思提取)  (置信度>0.95)  (LLM归纳)

                                   └────────── 长期记忆 ──────────┘
                                      (经过结构化萃取的知识)
```

### **5\.1 晋升触发条件**

| 阶段                           | 触发条件                                 | 执行者          |
| ------------------------------ | ---------------------------------------- | --------------- |
| In\-context → Out\-of\-context | 任务结束，context 移出                   | 系统自动        |
| Out\-of\-context → Experience  | 缓冲区容量达阈值 **或** 预设时间窗口到期 | 离线 LLM        |
| Experience → Skills            | confidence \> 0\.95                      | 系统检查 → 审核 |
| Skills \+ Experience → Persona | 技能数变化 ≥ N 个 **或** 定期触发        | 离线 LLM        |

### **5\.2 置信度的升降规则**

置信度在每次经验被引用后根据 Driver 反馈的 `effectiveness` 调整：

| effectiveness        | 置信度变化                    |
| -------------------- | ----------------------------- |
| fully\_effective     | \+0\.10                       |
| partially\_effective | \+0\.05（记录适配注意事项）   |
| ineffective          | \-0\.15（同时触发负经验生成） |
| not\_applicable      | 不变（不计入引用次数）        |

### **5\.3 晋升为 Skill 时的存储迁移**

当经验的 confidence \> 0\.95 触发晋升时：

1. `type` 从 `experience` 改为 `skill`

2. `content` 从经验格式（场景\+方案\+决策）重整为技能格式（步骤\+参数\+注意事项）

3. `description` 可能需要微调（技能描述比经验描述更通用化）

4. 重做 `description_embedding`（因为 description 可能变了）

5. 清空 experience 专属 metadata（confidence、linked\_negative\_exp），初始化 skill 专属 metadata（version、review\_status）

6. 原始经验记录进行删除，减少记忆载荷

## **6\. 记忆系统设计**

记忆系统分为三个组件：**In\-context（工作记忆）**、**Out\-of\-context（缓冲区）** 和 **长期记忆**。三者解决不同的问题：

```Plain Text
In-context (工作记忆)             Out-of-context (缓冲区)              长期记忆 (结构化知识)
─────────────────────           ──────────────────────              ─────────────────────
Persona (常驻)                  仅存 Driver 6 字段报告               Experience (反思提取)
任务描述 (随任务)                （artifacts + summary                   ↑
对话/思考 (上下文压缩管理)          + decisions + blockers         顶层 LLM 消费缓冲区
                                  + referenced_experiences              │
                                  + assumptions）                 Skills (经验晋升)
                                  ↓                               Persona (归纳)
                             唯一经验提取来源
```

### **6\.1 短期记忆**

In\-context 是顶层 LLM 的上下文工作区。它的管理方式采用**通用的上下文压缩方案**（滑动窗口、对话摘要等），与任何聊天系统处理长对话的方式没有本质区别。

In\-context 包含：

- Persona（常驻）

- 当前任务描述（随任务加载）

- 对话记录 / 思考记录（上下文压缩管理）

In\-context **不参与经验提取**。它里面的内容（顶层 LLM 的检索思路、组装决策、对话历史）对提炼可复用经验没有价值——顶层 LLM 没有真正"动手"，有价值的执行记录在 Driver 那边。

#### 上下文压缩管理细节

```Markdown
In-context 结构：

┌────────────────────────────────────┐
│  Persona (常驻，~200 tokens)       │  ← 永久占用，每次归纳后更新
├────────────────────────────────────┤
│  当前任务描述 (~100 tokens)        │  ← 任务开始时加载
├────────────────────────────────────┤
│  检索到的 Experience descriptions │  ← 执行阶段注
│  (top-K 的 description 列表，      │     入，认领阶段
│   不包含完整 content)              │     也使用
├────────────────────────────────────┤
│  对话/思考记录 (滑动窗口管理)       │  ← 只保留最近 N 轮
│  内容：                            │
│  - 顶层 LLM 的检索思路             │
│  - 顶层 LLM 组装的 prompt 摘要     │
│  - 收到的 Driver 返回摘要          │
│  - 对 Driver 返回的评估            │
├────────────────────────────────────┤
│  上下文压缩区                      │  ← 当窗口满时触发
│  (旧对话的结构化摘要)               │    压缩早期对话
└────────────────────────────────────┘

压缩触发条件：
- 顶层 LLM context 使用率 ≥ 70%
- 或对话轮次 ≥ MAX_TURNS (默认 50)

压缩方法（类似 Claude Code 的 Session Memory）：
1. 保留最近 RETAIN_TURNS 轮完整对话
2. 对更早的对话生成结构化摘要：
   - 已完成的工作
   - 关键决策及其结果
   - 当前状态和下一步计划
   - 未解决的问题
3. 摘要替换早期对话，降低 token 消耗
```

### **6\.2 Out\-of\-context（缓冲区）**

Out\-of\-context 是 **Driver 6 字段返回报告**的暂存区，经验提取的唯一原材料来源。

这里只存一类东西——Driver 每次任务返回的 6 字段报告（artifacts、summary、decisions、blockers、referenced\_experiences、assumptions）。没有对话历史、没有工具调用日志、没有顶层 LLM 的思考过程——这些对经验提取没有价值。

触发条件：

- 缓冲区容量达到阈值

- 经过预设的时间窗口（定时触发）

顶层 LLM 在离线模式下消费缓冲区中的 Driver 报告，提取出结构化的 Experience。提取完成后，报告可以压缩或淘汰——它们已经被萃取为长期记忆。

归一化到单一来源的价值：

- 提取管道简单可靠——一个标准的 ETL pipeline：Driver 报告入队 → 缓冲区 → 触发提取 → 顶层 LLM 消费单条报告 → 产出 Experience

- 如果出错，容易排查——只有一种输入格式

- 不依赖 Driver 之外的任何系统状态

#### 详细设计

```Bash
缓冲区结构：

/agent/{role_id}/buffer/
├── pending/                  ← 待处理队列
│   ├── report_001.json       ← Driver 返回（6字段完整报告）
│   ├── report_002.json
│   └── ...
├── processing/               ← 正在被提取的报告（锁保护）
├── processed/                ← 已提取完成的报告（7天后自动清理）
│   └── 2026/06/
│       └── report_001.json
└── buffer_meta.json          ← 缓冲区元数据

buffer_meta.json 内容：
{
  "pending_count": 5,
  "last_extraction_at": "2026-06-04T02:00:00Z",
  "last_extraction_report_count": 3,
  "last_extraction_experiences_created": 7,
  "cursor": 12                 ← 最后一个被处理的报告序号
}

触发策略（三层门控，由廉到贵）：
1. pending_count ≥ BATCH_SIZE（默认 3）→ 触发
2. pending 中最老报告距今 ≥ MAX_STALENESS（默认 6 小时）→ 触发
3. 存在一条 effectiveness="ineffective" 的报告 → 最高优先级触发

提取后处理：
- 成功提取的报告 → 移入 processed/
- 提取失败的报告 → 留在 pending/，重试计数器+1
- 重试 > MAX_RETRIES（默认 3）的报告 → 移入 dead_letter/，人工检查
```

### 6\.2 **Out\-of\-context（缓冲区方案2）**

方案1 的前提是"顶层 LLM 不做任务分析与分解，只做检索和组装"——所以缓冲区里只有 Driver 的 6 字段报告就够了，Driver 是唯一"动手"的人。

但在膨胀派模型下，顶层 LLM 自己做了大量工作：分解任务、编排多个 Driver、决定何时求助其他 Agent、合成多个 Driver 的返回结果。这些协调过程的上下文不存下来就丢了——它既不在 Driver 报告中，也不在最终的交付物里。

因此方案2 的做法很简单：**任务结束后，把顶层 LLM 的整个执行上下文做一份快照，和 Driver 报告一起放进缓冲区**。后台 LLM 自己会从这份原材料里提取有用的经验——它知道什么值得提取，不需要我们在缓冲区层面预设字段。

```Plain Text
/agent/{role_id}/buffer/
├── driver_reports/              ← 方案1 的内容，不变
│   ├── pending/
│   ├── processing/
│   └── processed/
├── coordinator_snapshots/       ← 方案2 新增
│   ├── pending/
│   │   ├── task_042.md          ← 顶层 LLM 的完整执行上下文（对话+决策+编排记录）
│   │   └── ...
│   ├── processing/
│   └── processed/
└── buffer_meta.json
```

`coordinator_snapshots/` 里存的就是顶层 LLM 的 in\-context 在任务结束时的完整快照——对话记录、分解决策、Driver 编排选择、跨 Agent 交互记录、结果合成过程，全部保留。后台 LLM 在提取经验时，同时消费这份快照和对应的 Driver 报告，一起提炼出可复用的知识。

方案1 和方案2 的区别只有一点：缓冲区里多了一份顶层 LLM 的执行快照。除此之外，提取管道、经验格式、置信度规则、技能晋升条件，全部不变。

### **6\.3 长期记忆**

长期记忆是**经过结构化萃取的知识**。它不是原始记忆的简单持久化，而是从中提炼出的、可被检索和复用的结构化记录。长期记忆包含三个层次：

| 层次           | 内容                                         | 来源                                        | 用途                                       |
| -------------- | -------------------------------------------- | ------------------------------------------- | ------------------------------------------ |
| **Experience** | 结构化的任务经验（场景\+方案\+决策\+置信度） | 离线 LLM 从缓冲区反思提取                   | 任务认领时检索，执行时注入 driver prompt   |
| **Skills**     | 久经验证的可复用能力                         | Experience 晋升（置信度 \> 0\.95）          | 跨 Agent 复用（技能市场），竞争力计算      |
| **Persona**    | Agent 当前能力画像                           | 系统定期对 Experience \+ Skills 做 LLM 归纳 | 对外帮助用户了解 Agent，对内辅助竞争力自评 |

长期记忆的存储采用 ReMe 式的检索/载荷分离方案，详见第 9 节。

### **6\.4 完整工作流程**

```Plain Text
任务发布 → ①检索长期记忆（Experience / Skills）
  → ②加载到 in-context
  → ③执行任务（顶层 LLM 组装 prompt → Driver 执行）
  → ④用户评分
  → ⑤Driver 6 字段报告进入缓冲区 (out-of-context)
  → ⑥（缓冲区触发）顶层 LLM 离线消费 Driver 报告 → 提取 Experience
  → ⑦Experience 入库（长期记忆）
  → ⑧（可选）置信度 > 0.95 → ⑨晋升为 Skill（长期记忆）
  → ⑩（可选）Skills 变化触发 Persona 重新归纳
```

## **7\. Agent 执行模型**

每个 Agent 内部由两个组件协作完成任务：**顶层 LLM**（负责 prompt 组装和经验提取）和 **Driver**（负责实际执行）。值得注意的是，**这里不存在第三个模型**——文档中提到的"离线 LLM"就是同一个顶层 LLM 在离线模式下的工作形态，不是独立的模型实例。

顶层 LLM 自己不写代码、不操作文件、不调用 DevOps API——这些"动手"的活全部交给 Driver。顶层 LLM 只做两件事：

\- **执行阶段（在线）**：检索相关经验和技能，组装精准的 prompt 下发给 Driver，收到返回后更新 Metrics

\- **反思阶段（离线）**：消费 Driver 返回的结构化报告，提取经验、调整置信度、检查技能晋升

经验和技能的**唯一原材料来源是 Driver 的报告**，不是顶层 LLM 自己的行为。顶层 LLM 本质上是一个**经验萃取器**——它阅读 Driver 的报告，从中提炼出可复用的知识模式。

### **7\.1 职责分离**

```Plain Text
顶层 LLM（prompt 组装 + 经验提取）    Driver（执行者）
─────────────────────────────        ─────────────────────
Persona  → 决定接不接任务             接到组装好的 prompt
Skills   → 织入 prompt 模板          按 prompt 执行编写/调试
Experience → 正/负经验注入           返回 6 字段报告
Memory   → 检索                       （artifacts + summary
Metrics  → 事后更新                     + decisions + blockers
                                       + referenced_experiences
反思阶段（离线）：                       + assumptions）
← 消费 Driver 报告
← 提取 Experience
← 调整置信度
← 检查 Skill 晋升
← 更新 Persona
```

\- **顶层 LLM**：不写代码、不操作文件、不调用 DevOps 工具。它的工作全部围绕"信息处理"——检索记忆、组装 prompt、阅读 Driver 返回、从中提取可复用的经验。它在两种模式间切换：**在线模式**处理单次任务（检索 → 组装 → 下发 → 更新 Metrics），**离线模式**处理缓冲区积累的 Driver 报告（消费 → 提取 → 晋升）。

\- **Driver**：负责具体的动手操作。它是可插拔的外部工具——Claude Code CLI、Gemini CLI、Codex CLI 等。接收组装好的 prompt，执行编写、调试、部署，返回结构化报告供顶层 LLM 之后萃取经验。

### **7\.2 为什么分层**

| 问题                 | 单模型方案                                                     | 双模型方案                                                                                    |
| -------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 代码细节挤占 context | 顶层 LLM 的 context 被大量代码和调试信息填满                   | 代码细节卸载到 driver，顶层 LLM 的 context 保持干净                                           |
| 不同任务需要不同工具 | 单一模型难以在所有场景最优                                     | driver 可按任务类型切换                                                                       |
| 经验注入的精准度     | 模型在大量上下文中自行检索，噪声高                             | 顶层 LLM 精准检索后注入 driver prompt                                                         |
| **经验来源**         | 模型从自己的行为中学习——"动手"和"反思"混在一起，经验提取不独立 | 顶层 LLM 只做萃取，从不"动手"。经验和技能全部来自对 Driver 报告的二次加工，来源独立、质量可控 |

最后一行的含义：如果顶层 LLM 既动手又反思，它学到的经验会掺杂"自己做对了什么"的主观视角。双模型让**执行者（Driver）**和**反思者（顶层 LLM）**分离——Driver 不带偏见地执行并记录过程，顶层 LLM 以旁观者视角阅读报告、提取模式。这类似于代码 review 中开发者不能 review 自己代码的原则。

### **7\.3 顶层 LLM 的 Context 结构**

顶层 LLM 的 context 只装它**自己工作所需**的信息——检索记忆和组装 prompt。不包含任何执行层面的细节（项目技术栈、架构约定等），因为这些只对 Driver 有用，顶层 LLM 用不着。

```Plain Text
┌──────────────────────────────────┐
│  Persona                         │  ← 相对稳定，竞争力自评用
│  （我是谁、我擅长什么）             │
├──────────────────────────────────┤
│  当前任务描述                      │  ← 随任务加载，检索用
├──────────────────────────────────┤
│  对话记录 / 思考记录               │  ← 上下文压缩管理（摘要/滑动窗口）
│                                  │      不参与经验提取
└──────────────────────────────────┘
```

Skills 和 Experience **不在 context 中**。它们存储在外部，顶层 LLM 只持有元信息（名称、描述、适用领域标签）。被选中的 skill 内容和经验记录直接写入 driver prompt，不经过顶层 LLM 的 context。

### **7\.4 Driver 返回规范**

Driver 的返回内容是经验提取的**唯一原材料**。返回需遵循六字段结构：

```Plain Text
┌─────────────────────────────────────────────────┐
│  1. artifacts         产物列表                    │
│  2. summary           执行摘要              │
│  3. decisions         关键决策点 ★ 最重要          │
│  4. blockers          卡点与解决                   │
│  5. referenced_experiences  引用经验表现反馈       │
│  6. assumptions       假设与边界                   │
└─────────────────────────────────────────────────┘
```

#### **① artifacts（产物）**

```JSON
{
  "artifacts": [
    { "type": "code_diff",    "path": "src/auth/login.ts", "summary": "参数化查询改造" },
    { "type": "test_report", "path": "tests/auth/",        "summary": "新增 12 个测试用例，全部通过" }
  ]
}
```

#### **② summary（执行摘要）**

3\-5 句话概括执行过程。让反思 LLM 快速建立全局认知。

#### **③ decisions（关键决策点）**

执行过程中面临的岔路口——选了哪条路、放弃了哪条路、为什么。

```JSON
{
  "decisions": [
    {
      "point": "SQL 注入修复方案选择",
      "options": ["参数化查询改造", "硬编码输入过滤"],
      "chosen": "参数化查询改造",
      "reason": "从源头消除注入风险，后续新增查询也受保护"
    }
  ]
}
```

反思 LLM 拿到决策点后，可以提取出跨 driver、跨语言都能复用的决策模式。

#### **④ blockers（卡点与解决）**

```JSON
{
  "blockers": [
    {
      "blocker": "旧版 MySQL 驱动不支持参数化查询 API",
      "attempts": ["直接用 mysql.query() → 废弃 API 报错", "升级驱动 → 版本不兼容"],
      "resolution": "使用 mysql2 驱动的 prepared statements 接口",
      "resolved": true
    }
  ]
}
```

#### **⑤ referenced\_experiences（引用经验表现）**

顶层 LLM 注入了若干参考经验。Driver 需反馈每条经验的实际效果：

```JSON
{
  "referenced_experiences": [
    {
      "experience_id": "#001",
      "applied": true,
      "effectiveness": "partially_effective",
      "note": "参数化查询方案直接可用，WAF 配置部分需重写"
    }
  ]
}
```

`effectiveness` 枚举：`fully_effective` / `partially_effective` / `ineffective` / `not_applicable`。

#### **⑥ assumptions（假设与边界）**

```JSON
{
  "assumptions": [
    { "assumption": "目标代码库使用 Node.js + MySQL", "risk_if_wrong": "所有方案需重新评估" }
  ]
}
```

### **7\.5 为什么不让 Driver 直接写经验**

一个自然的疑问是：Driver 执行完任务，它最清楚做了什么，为什么不直接让它返回经验？

即使我们把全局信息（项目背景、技术栈、架构约定）都注入给了 Driver，也不应该让 Driver 直接写经验。根本原因只有一个：

**顶层 LLM 是唯一的经验萃取器，必须保持执行者无关。**

同一个 Agent 可能在不同任务中使用不同的 Driver（安全任务用 Claude Code，前端迭代用 Gemini CLI）。如果让每个 Driver 各自写经验，不同 Driver 产出的经验格式、质量、抽象层级都不一样——Claude Code 的经验可能冗长详尽，Codex CLI 的经验可能过于简略。经验库会逐渐碎片化。

统一由顶层 LLM 萃取的意义：无论这次任务用的是哪个 Driver，顶层 LLM 都按同一套流程读取 6 字段报告、提取经验、更新置信度。经验库的质量受顶层 LLM 控制，不受底层 Driver 影响。Driver 可以随意替换，经验提取管道不需要改变。

换句话说，Driver 知道得再多（全局信息、任务上下文、代码细节），它的视角仍然是"这一次怎么做会成功"。而经验需要的是"什么场景下什么方案有效、什么条件下不适用"——这是萃取者的工作，不是执行者的工作。执行者提供原材料（6 字段报告），萃取者提炼知识。职责分离在这里依然是正确的设计原则。此外，经验提取不一定是在每次任务完成都触发，可以多次完成后一起触发（如仿照claude的dreaming机制）。

## **8\. Agent 生命周期**

### **8\.1 分裂（Respawn）**

当 Agent 的技能在一个领域内积累过深、覆盖了多个差异明显的子方向时，该 Agent 应该分裂。

**为什么需要分裂**：检索精度取决于 skill description 向量的相似度。当同一个 agent 持有 20\+ 个安全技能，但其中 SQL 注入修复和容器网络隔离几乎没有语义重叠时，每次检索都会有一部分技能成为噪声。此外，过宽的技能范围也让 Persona 难以精准描述。

**分裂规则**：

1. 对 Agent 的所有 Skills 的 `description_embedding` 做向量聚类，识别子方向

2. 每个聚类形成一个新 Agent，继承对应 Skills 的完整载荷

3. Experience 按 description 语义相似度分配给最接近的新 Agent

4. 原 Agent 的 Persona 废弃，各新 Agent 重新归纳自己的 Persona

5. 各新 Agent 从白板 Metrics 开始

```Plain Text
分裂前：Agent Alpha（安全 / 27 个 skills）
         ├── 代码层加固：SQL注入、XSS、SSRF...（12个）
         ├── 基础设施安全：WAF、网络隔离...（9个）
         └── 合规审计：OWASP、SOC2...（6个）
                      ↓ description_embedding 聚类
       ┌───────────────┼───────────────┐
       ▼               ▼               ▼
  Alpha-Code       Alpha-Infra     Alpha-Audit
  (代码层安全)      (基础设施安全)    (合规审计)
```

#### 分裂的执行流程

```Markdown
分裂流程：

Phase 1 — Plan
─────────────────
1. 对 Skills 做向量聚类，得到 K 个聚类
2. 为每个聚类命名（LLM 根据聚类内 Skills 的 description 生成聚类标签）
3. 对每条 Experience 计算与各聚类质心的相似度
4. 分配给最接近的聚类（相似度 > 0.3 才分配，否则丢弃）
5. 生成分裂计划，进入确认

Phase 2 — Fork
─────────────────
6. 创建 K 个新 Agent（白板 Metrics，继承聚类标签作为初始 tags）
7. 为每个新 Agent 导入对应 Skills（完整载荷）
8. 为每个新 Agent 导入分配的 Experiences（完整载荷）
9. 设置新 Agent 的初始 Persona（基于导入的 Skills 和 Experiences 立即归纳）
10. 将新 Agent 注册到 Agent 注册表

Phase 3 — Migrate
─────────────────
11. 原 Agent 标记为 "draining"（不接受新任务）
12. 等待原 Agent 的进行中任务完成
13. 检查是否有孤儿 Experience（未分配给任何新 Agent）：
    - 置信度 > 0.5 的孤儿：保留到"通用经验池"
    - 置信度 ≤ 0.5 的孤儿：丢弃

Phase 4 — Archive
─────────────────
14. 原 Agent 的 Persona 归档（标记 final 版本）
15. 原 Agent 标记为 "retired"（reason: "split"）
16. 原 Agent 的 Metrics 归档，不做迁移
17. 写入分裂日志
```

#### 分裂的触发条件

```Plain Text
第一层：轻量统计检查（每次技能数变化后执行，O(1)）

检查条件（满足任一则进入第二层）：
- skills.length ≥ SPLIT_THRESHOLD_SKILLS（默认 15）
- skills 的 tags 集合基数 ≥ SPLIT_THRESHOLD_TAGS（默认 4）
  （tags 高度分散说明领域跨度大）

第二层：向量聚类分析（进入第一层后执行，O(n²) 用于计算相似度矩阵）

步骤：
1. 收集所有 Skill 的 description_embedding（已有，不需要重新计算）
2. 计算 pairwise 余弦相似度矩阵
3. 使用 HDBSCAN 或 Agglomerative Clustering：
   - HDBSCAN 优势：不需要预设聚类数，自动识别噪声点
   - 参数：min_cluster_size = 3, min_samples = 2
   - 或使用 Agglomerative Clustering with distance_threshold
4. 聚类结果判断：
   - 聚类数 ≥ 2 AND 每个聚类的 skill 数 ≥ MIN_SPLIT_SIZE（默认 3）
   - 聚类间平均相似度 < SPLIT_SIMILARITY_THRESHOLD（默认 0.4）
   → 满足则进入第三层

第三层：分裂确认

条件：
- dry_run 模式：仅生成预览，不执行
- 正式模式：确认所有条件满足后，写入分裂计划，等待窗口期
```

### **8\.2 退休（Retire）**

当一个 Agent 长期接不到任务，或接到任务后频繁失败，说明它的成长方向跑偏了，应该退休。

#### 触发条件

**判断条件**（满足任一）：

- 连续 N 个任务窗口内，加权抽签从未中标

- 近期任务成功率持续低于阈值（如最近 10 次成功率 \< 30%）

- Persona 反复大幅漂移，始终无法稳定在某个领域

**实际设计：**

**第一层：轻量扫描（每次 Metrics 更新后，O\(1\)）**

```Plain Text
A. days_since_last_won > 90          → 进入第二层
B. recent_10_success_rate < 0.30    → 进入第二层
```

`recent_10_success_rate` 排除进行中、未评分和探索性任务。total\_tasks \< 20 时阈值降至 0\.15。

**第二层：Persona 漂移分析（第一层触发后，冷却 7 天）**

```Plain Text
C. 连续 3 个版本 pairwise 相似度 < 0.6   → 进入第三层
D. max(各领域 Z-score) < 1.5              → 进入第三层
```

total\_tasks \< 20 时不触发（探索期漂移正常）。

**第三层：LLM 全面评估（第二层触发后，冷却 30 天）**

- Skill 市场可替代性评估（≥ 70% 有市场等效则退休损失可控）

- 经验可恢复性评估

- 输出：recommended\_action\('retire'\|'warn'\|'keep'\) \+ confidence \+ reasoning

#### **退休策略**

|      | Skills                                             | Experience                                        | Persona / Metrics                           |
| ---- | -------------------------------------------------- | ------------------------------------------------- | ------------------------------------------- |
| 处置 | 保留，进入技能市场供其他 Agent 引入                | 丢弃——低成功率的经验置信度本身就低                | 归档，不做迁移                              |
| 理由 | Skills 是久经验证的可靠知识，不因 Agent 失败而贬值 | Experience 未达晋升门槛，批量失败说明适用性有问题 | 每个 Agent 的成长路径不同，不应污染新 Agent |

**Skills 处置决策树**

```Plain Text
对每条 Skill：
  市场中相似度 > 0.80  → 不保留，标记 superseded
  imported_by.length > 0 → 保留，ownership 转移至市场
  review_status = approved → 保留
  review_status = pending  → 触发审核
  review_status = rejected → 不保留
  市场中最相似 < 0.70      → 保留并标记 "retired_agent_unique"，提高推荐优先级
  linked_neg 占比 > 0.3      → 保留但附加警告标记
```

**Experiences 分级处置**

孤儿经验池限制：新 Agent 最多吸收 3 条。inherited Skill 首次成功后转为 active。

#### 替代策略

分为纯白板（A）和种子白板（B）两种替代 Agent。

- 退休原因 = Persona 漂移 → 策略 B（种子白板）：继承退休 Agent 早期的领域方向 \+ 1\-2 条 A 级经验

- 退休原因 = 低成功率 → 策略 A（纯白板）

- 退休原因 = 长期未中标 → 策略 B（种子白板）

### **8\.3 Skills/Experience 分离带来的生命周期清晰性**

如果 Skills 和 Experience 混在一起：

- 分裂时，不知道哪些知识该分出去、哪些该留

- 退休时，不知道哪些知识该保留、哪些该丢弃

- 每次都需要人工判断什么是"可靠知识"、什么是"个人笔记"

Skills 和 Experience 的分层提供了天然的分界线：久经验证的可以传递，未经验证的随 agent 生命周期自然淘汰。

## **9\. 存储设计**

Skills 和 Experience 采用 **ReMe 思路**：检索面和载荷面分离，短文本做 embedding，完整内容做 payload。

### **9\.1 为什么用 ReMe 而非全文向量化**

| 维度                    | 全文向量化（mem0 思路）                                     | ReMe 检索/载荷分离                                |
| ----------------------- | ----------------------------------------------------------- | ------------------------------------------------- |
| 检索精度                | 长文向量语义稀释，经验被 ORM 细节污染，可能被无关任务误召回 | 短 description 语义集中，召回的边界更清晰         |
| 与 context 分层的契合度 | 无区分，内容即索引                                          | 顶层 LLM 拿 description 做筛选，内容直接给 driver |
| 更新成本                | 内容每次微调都需重做 embedding                              | 仅 description 变才重做                           |
| 跨 Agent 复用           | 困难，embedding 包含 Agent 特定上下文                       | description 可跨 Agent 共享                       |

### **9\.2 存储结构**

```Plain Text
┌─────────────────────────────────────────────┐
│  索引层（向量库，参与检索）                      │
│  ┌─────────────────────────────────────────┐ │
│  │ id                    ← UUID            │ │
│  │ description_embedding ← 检索用向量        │ │
│  │ type                  ← skill|experience │ │
│  │ tags                  ← 领域标签          │ │
│  │ agent_id              ← 所属 Agent       │ │
│  └─────────────────────────────────────────┘ │
├─────────────────────────────────────────────┤
│  载荷层（结构化 JSON，不参与向量化）              │
│  ┌─────────────────────────────────────────┐ │
│  │ id            ← 同索引层 UUID            │ │
│  │ description   ← 原始短描述（≤3句话）       │ │
│  │ content       ← 完整内容，注入 driver      │ │
│  │ metadata      ← 置信度、版本、关联经验等    │ │
│  └─────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

#### **metadata 按 type 区分**

```Plain Text
Skill metadata                    Experience metadata
───────────────────────────       ───────────────────────────
version: str                       confidence: float (0.0-1.0)
sub_skills: list[str]              referenced_count: int
review_status: str                 last_referenced_at: datetime
                                   linked_negative_exp: list[str]
                                   assumptions: list[str]
                                   promoted_to: str (skill_id | null)
```

### **9\.3 检索流程**

```Plain Text
任务描述
  │
  ▼
向量化（同模型、同维度）
  │
  ▼
在索引层中搜索 description_embedding
  ├── 过滤：agent_id = 当前 Agent
  ├── 可选过滤：type = skill | experience，tags 匹配
  └── 返回：top-K 相似项
  │
  ▼
顶层 LLM 收到 top-K 的 description 列表
  ├── 认领阶段 → 判断自己在该任务上的竞争力
  └── 执行阶段 → 筛选最相关的 N 条，拉取 content
  │
  ▼
将选中的 content 织入 driver prompt

Step 1: 向量粗筛
  任务描述 → embedding → 索引层 top-K 查询 (K=20)
  过滤条件：
  - agent_id = 当前 Agent
  - confidence ≥ MIN_RETRIEVAL_CONFIDENCE (默认 0.2)
  - type 过滤（认领阶段 all，执行阶段 skill+experience）

Step 2: LLM 精筛
  顶层 LLM 收到 top-K 的 description 列表
  对每条判断：
  - 内容是否与当前任务直接相关
  - 是否是重复/冗余内容
  - 置信度是否可信
  选择最终 N 条（N ≤ 5）

Step 3: 载荷注入
  拉取选中条目的 content
  组装到 driver prompt 的 "参考经验/技能" 部分

内部检索（负经验关联检索）：
  当检索到一条正经验时：
  - 检查其 linked_negative_exp 字段
  - 自动拉取所有关联负经验的 description
  - 与正经验一起注入 driver prompt（作为 "注意事项"）
```

筛选由顶层 LLM 完成，不靠纯向量距离的 top\-N 硬截断——因为向量相似度可能召出 3 条高度相关但内容重复的经验，漏掉 1 条稍低但覆盖了不同子领域的经验。

### **9\.4 Description 的写法要求**

Description 是检索的唯一入口。离线 LLM 提取经验时必须遵循：

- 不超过 3 句话

- 包含触发场景（什么情况下检索到）

- 包含方案关键词（精确到能被同领域任务命中）

\- **不包含**具体项目名、文件名、driver 名

```Plain Text
差的 description：
"在 shopping-cart 项目中用参数化查询和 WAF 解决了安全问题"
  → 被 "shopping-cart" 污染，payment-api 的任务可能召不出

好的 description：
"Web 应用安全加固：SQL 注入的参数化查询改造 + XSS 输出编码 + WAF 规则配置"
  → 关键词密集、领域明确、项目无关
```

## **10\. API 接口规约**

以下定义 Agent 角色和记忆系统的核心接口。采用 TypeScript 风格描述参数与返回值类型。

### **10\.1 Agent 管理**

**agent\.create\(spec\)**

创建一个新的白板 Agent。

```TypeScript
interface CreateAgentSpec {
  role_id: string;
  name: string;
  tags?: string[];
  persona_seed?: string;    // 可选的初始 Persona 描述
  constraints?: string[];   // 硬约束
}

interface AgentHandle {
  role_id: string;
  name: string;
  persona: PersonaDef;
  skill_count: number;
  experience_count: number;
  status: 'created' | 'active' | 'idle' | 'draining' | 'retired';
  created_at: string;
}

function agentCreate(spec: CreateAgentSpec): Promise<AgentHandle>;
```

**agent\.get\_persona\(role\_id\)**

获取 Agent 当前的 Persona。

```TypeScript
interface PersonaDef {
  role_id: string;
  version: number;
  summary: string;          // 专长领域归纳
  skills_overview: string;  // 掌握技能概览
  experience_coverage: string; // 经验覆盖范围
  recent_performance: string;  // 近期表现
  notes: string;            // 注意事项
  generated_at: string;
}

function agentGetPersona(role_id: string): Promise<PersonaDef>;
```

**agent\.list\(\)**

列出所有 Agent 及其当前状态。

```TypeScript
function agentList(opts?: {
  status?: 'active' | 'idle' | 'retired';
  tags?: string[];
}): Promise<AgentHandle[]>;
```

### **10\.2 经验管理**

**experience\.query\(role\_id, query, opts?\)**

检索与当前任务最相关的经验。

```TypeScript
interface ExperienceRecord {
  id: string;
  description: string;      // 短描述
  content: string;          // 完整内容（方案+决策+假设）
  confidence: number;       // 0.0 - 1.0
  tags: string[];
  linked_negative_exp: string[];  // 关联的负经验 ID
  promoted_to?: string;     // 若已晋升，指向 skill_id
}

interface QueryOptions {
  top_k?: number;           // 返回条数，默认 10
  type?: 'experience' | 'skill' | 'all';
  min_confidence?: number;
  tags?: string[];
}

function experienceQuery(
  role_id: string,
  query: string,
  opts?: QueryOptions
): Promise<ExperienceRecord[]>;
```

**experience\.extract\(role\_id, buffer\_snapshot\)**

触发一次经验提取（通常由系统自动调用，但也提供手动触发入口）。

```TypeScript
interface BufferSnapshot {
  task_id: string;
  task_description: string;
  user_rating?: string;
  driver_return: DriverReturn;   // 见 §7.4 六字段
  source_task_id: string;
  source_driver: string;
}

interface ExtractResult {
  experiences_created: number;
  experiences_updated: number;   // 置信度调整
  negative_experiences: number;
  skills_promoted: number;       // 本次晋升的技能数
}

function experienceExtract(
  role_id: string,
  buffer_snapshot: BufferSnapshot
): Promise<ExtractResult>;
```

**experience\.get\_source\(experience\_id\)**

获取经验的证据链（原始任务上下文、Driver 返回等）。

```TypeScript
interface ExperienceSource {
  experience_id: string;
  source_task_id: string;
  source_driver: string;
  source_artifacts: Array<{type: string; path: string; summary: string}>;
  source_user_rating?: string;
  source_assumptions: string[];
  confidence_history: Array<{value: number; updated_at: string; reason: string}>;
}

function experienceGetSource(experience_id: string): Promise<ExperienceSource>;
```

### **10\.3 技能管理**

**skill\.promote\(experience\_id\)**

手动晋升一条经验为技能（通常由系统自动处理，人工审核介入时使用）。

```TypeScript
interface SkillRecord {
  id: string;
  description: string;
  content: string;          // 技能格式（步骤+参数+注意事项）
  version: string;          // semver
  review_status: 'pending' | 'approved' | 'rejected';
  sub_skills: string[];
  tags: string[];
  promoted_from: string;    // 来源 experience_id
  promoted_at: string;
}

function skillPromote(
  experience_id: string,
  opts?: { review_status?: 'approved' | 'pending' }
): Promise<SkillRecord>;
```

**skill\.market\_search\(query, opts?\)**

在技能市场中搜索可引入的技能。

```TypeScript
function skillMarketSearch(
  query: string,
  opts?: { top_k?: number; tags?: string[] }
): Promise<SkillRecord[]>;
```

**skill\.market\_import\(role\_id, skill\_id\)**

将技能市场中的技能引入到指定 Agent。

```TypeScript
function skillMarketImport(
  role_id: string,
  skill_id: string
): Promise<{ imported: SkillRecord; note: string }>;
```

### **10\.4 生命周期管理**

**agent\.respawn\(role\_id, opts?\)**

触发 Agent 分裂。

```TypeScript
interface RespawnOptions {
  cluster_threshold?: number;   // 向量聚类相似度阈值，默认自动
  dry_run?: boolean;            // 仅预览分裂结果，不实际执行
}

interface RespawnResult {
  original_agent: string;
  new_agents: Array<{
    role_id: string;
    name: string;
    inherited_skills: string[];
    inherited_experience_count: number;
  }>;
}

function agentRespawn(
  role_id: string,
  opts?: RespawnOptions
): Promise<RespawnResult>;
```

**agent\.retire\(role\_id, reason?\)**

触发 Agent 退休。

```TypeScript
interface RetireResult {
  role_id: string;
  retired_at: string;
  skills_preserved: number;      // 进入技能市场的技能数
  experiences_discarded: number;
  archived_persona_version: number;
}

function agentRetire(
  role_id: string,
  reason?: 'performance_degradation' | 'inactivity' | 'persona_drift' | 'manual'
): Promise<RetireResult>;
```

### **10\.5 Metrics**

**agent\.get\_metrics\(role\_id, period?\)**

获取 Agent 的绩效指标。

```TypeScript
interface AgentMetrics {
  role_id: string;
  period_start: string;
  period_end: string;
  total_tasks: number;
  success_rate: number;
  average_confidence: number;
  skill_count: number;
  experience_count: number;
  token_cost_total: number;
}

function agentGetMetrics(
  role_id: string,
  period?: { start: string; end: string }
): Promise<AgentMetrics>;
```

## **11\. 现有方案对比**

本方案建立在以下五个现有系统的调研基础上。

### **11\.1 编码类 Agent 记忆系统**

| 维度          | Bitfun               | Claude Code                  | OpenCode           | 本方案                                                         |
| ------------- | -------------------- | ---------------------------- | ------------------ | -------------------------------------------------------------- |
| 持久化方式    | 文件系统（Markdown） | 多层文件 \+ MEMORY\.md 索引  | SQLite（仅会话内） | 向量库索引 \+ JSON 载荷                                        |
| 跨会话记忆    | ✅ 文件持久          | ✅ 多层持久                  | ❌ 仅指令文件      | ✅ 缓冲区\(out\-of\-context\) → 长期记忆\(Experience\+Skills\) |
| 写入机制      | LLM 自写日记         | 双通道（主模型 \+ 子 Agent） | 系统自动压缩       | Driver 6 字段报告 → 缓冲区 → 顶层 LLM 离线提取                 |
| 记忆整理      | 无自动化             | Dream 自动整合               | 会话压缩           | 顶层 LLM（离线模式）提取 \+ 置信度升降                         |
| 能力成长      | ❌                   | ❌                           | ❌                 | ✅ Experience → Skill → Persona                                |
| 跨 Agent 复用 | ❌                   | ❌                           | ❌                 | ✅ 技能市场                                                    |
| 生命周期      | ❌                   | ❌                           | ❌                 | ✅ Respawn / Retire                                            |

### **11\.2 通用记忆平台**

| 维度       | Letta \(memGPT\)         | mem0        | Zep            | 本方案                                 |
| ---------- | ------------------------ | ----------- | -------------- | -------------------------------------- |
| 记忆分层   | Core / Recall / Archival | 向量优先    | 双时序知识图谱 | 短期/长期 \+ 经验/技能/Persona         |
| 能力抽象   | ❌                       | ❌          | ❌             | ✅ Experience / Skills / Persona       |
| 检索方式   | 分层 paging              | 语义相似度  | 图遍历 \+ 向量 | description\_embedding → 顶层 LLM 筛选 |
| 代理自管理 | ✅                       | ⚠️ 被动提取 | ✅ 白盒提取    | ✅ Driver 返回 → 反思提取              |
| 治理层     | ❌                       | ❌          | ❌             | 计划中（persona 版本化、audit\_log）   |

### **11\.3 设计选择总结**

本方案从各系统中吸收了关键思想：

\- 从 **Letta** 借鉴了分层记忆和外部存储思想

\- 从 **Claude Code** 借鉴了后台反思、自动提取、长期沉淀的思路

\- 从 **OpenCode** 借鉴了工作记忆与执行上下文隔离

\- 从 **ReMe / Bitfun** 发展出了检索面和载荷面分离

\- 新增了 **Experience → Skill → Persona** 的能力成长链路和 **Respawn / Retire** 生命周期管理

## 开放问题

#### 顶层 LLM 的职责边界：记忆提取器，还是真正的"大脑"？

在当前设计下，顶层 LLM 的职责被严格限定为：

- **在线模式**：检索记忆 → 组装 prompt → 下发 Driver → 更新 Metrics

- **离线模式**：消费 Driver 报告 → 提取 Experience → 晋升 Skill

这是一个纯粹的记忆提取器和 prompt 组装器。Driver 承担了所有"动脑"的工作——理解任务、拆解步骤、做技术决策、执行工具调用。

但这就引出一个问题：**我们是否低估了顶层 LLM 可以扮演的角色？**

如果把顶层 LLM 设计得更像一个真正的"大脑"，它可以承担更多协调层的职责：

1. **任务分解（Task Decomposition）**

当前 Driver 收到一个完整任务，自己理解、自己拆解、自己执行。但如果顶层 LLM 先把任务分解成子任务 DAG，再分派给多个 Driver 实例并行执行呢？

这类似于方向 C 中 `task.subtask` \+ `task.fork/join` 原语——但区别在于，方向 C 的分解发生在 Agent **之间**（Agent A 向 Agent B 派发子任务），而这里讨论的分解发生在 Agent **内部**（顶层 LLM 把大任务拆成多个 Driver 可并行的小块）。

2. **多 Driver 编排**

如果顶层 LLM 能同时管理多个 Driver 实例，就可以并行执行互不依赖的子任务、让不同 Driver 做同一件事后择优、或者让一个 Driver 继续执行、另一个 Driver 做交叉验证。这会从根本上改变系统的吞吐量——不是单线程的"组装 prompt → 等返回 → 再组装"，而是多个 Driver 同时在跑。

3. **跨 Agent 交互的决策者**

当前设计中，Agent 与 Agent 之间的交互（`agent.message`、`agent.ask_help`、`agent.escalate` 等原语）由方向 C 的 Scaffold 层处理。但如果顶层 LLM 是"大脑"，它应该有权决定何时需要求助、何时需要上报、何时可以独立完成——而不是把这些决策上提到 Scaffold 层。

换句话说：Scaffold 提供通信能力，但**通信的决策者**应该是顶层 LLM。它知道自己擅长什么（Persona），知道当前任务卡在哪里，知道什么时候需要别人帮忙。

**矛盾点：剥离 vs 膨胀**

这里有一个设计张力需要讨论：

- **剥离派**：顶层 LLM 保持轻量，只做检索和组装。任务分解由 Driver 自己负责，跨 Agent 交互由 Scaffold 层处理。每一层职责单一，好测试、好替换。

- **膨胀派**：顶层 LLM 承担协调职责——分解任务、编排多 Driver、决定跨 Agent 交互。这会增加顶层 LLM 的 context 负担，但能让 Agent 作为一个整体变得更智能、更主动。

当前设计选择了剥离派。但这是唯一的正确答案吗？如果选择膨胀派，顶层 LLM 从"记忆提取器 \+ prompt 组装器"进化为"协调者 \+ 决策者"，我们需要改变哪些设计？

## 13\.方向B需要的hook与gate

### 13\.1 **需要 D 新增的 Hook 事件**

### 13\.2 **各事件 Payload 字段说明**

1. **agent\.experience\_extracted**

2. **agent\.skill\_promoted**

3. **agent\.respawn（dry\_run 阶段）**

4. **agent\.respawned（正式执行后）**

### 13\.3 **需要 D 新增的 Gate**

## 14\.Metrics 的详细设计

### 14\.1 指标采集

事件驱动，原子增量写入：

派生指标实时计算，不单独持久化。原始指标（事实数据）持久化，竞争力分数不持久化。

### 14\.2 指标字段

**原始指标（持久化）：**

```Plain Text
total_tasks, tasks_bid, tasks_won, tasks_completed
tasks_succeeded, tasks_partial, tasks_failed
skill_count, experience_count, imported_skill_count, promoted_skill_count
avg_confidence, token_cost_total
first_task_at, last_task_at, last_won_at
persona_version, persona_drift, persona_stable_since
```

**派生指标（实时计算）：**

```Plain Text
success_rate      = tasks_succeeded / tasks_completed
bid_win_rate      = tasks_won / tasks_bid
experience_density = experience_count / total_tasks
skill_density     = skill_count / experience_count
activity_score    = 1.0 / (1.0 + days_since_last_task / 14)
```

### 14\.3 竞争力估值公式

```Plain Text
C(agent, task) = 0.40 × relevance + 0.30 × quality + 0.15 × capacity + 0.10 × freshness + bonus

relevance = 0.6 × skill_match + 0.4 × experience_match
  skill_match:     任务 tags 与 Agent Skills/Persona tags 的匹配度，取加权平均
  experience_match: top-K 经验的 confidence 加权和，有负经验关联的减半

quality = 0.5 × recent_success_rate + 0.3 × avg_confidence + 0.2 × experience_density
  recent_success_rate: 最近 min(20, total_tasks) 次的成功率
  total_tasks < 3 时使用全局基准值 0.5

capacity = 1.0 - min(1.0, active_task_count / 3)

freshness = 1.0 / (1.0 + days_since_last_task / 14)

bonus = total_tasks < 5 ? 0.15 : 0.0          // 新手保护，5 次任务后消失
```

### 14\.4 加权抽签算法

```Plain Text
输入：所有竞标 Agent 的 C(agent, task)
输出：选中的 Agent

1. adjusted[agent] = exp(C(agent, task) / τ)    // τ=0.5 默认值
2. prob[agent] = adjusted[agent] / Σ adjusted
3. r = random(0, Σ adjusted)
4. 按 adjusted 降序遍历，累积到 r 时选中
5. 为所有候选人记录 bid 事件，为中选者记录 won 事件
```

τ 按任务类型调整：关键变更 τ=0\.3，探索性实验 τ=0\.8。

### 14\.5 分区指标

按领域标签切片，用于识别 Agent 在不同领域的差异化能力。任务标签与 Agent 经验标签不一致的任务标记为"探索性"，不计入标准成功率。

### 14\.6 时间衰减

指标对竞争力估值的影响权重随时间衰减，原始数据不删除：

- success\_rate 相关事件：半衰期 70 天（λ=0\.01）

- confidence 相关更新：半衰期 35 天（λ=0\.02）

- activity\_score 相关：半衰期 14 天（λ=0\.05）
