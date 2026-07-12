# 方向B：Agent角色与记忆系统——Spec

## **1\. 文档定位**

本 Spec 是 RFC《Agent 角色与记忆系统》的数据契约文档。它将 RFC 中描述的 Persona、Skill、Experience、In\-context、Out\-of\-context、Driver 报告缓冲区、以及 Experience → Skills → Persona 晋升链路，整理为**可开发的结构化数据契约**。各方向在实现时以本 Spec 中的字段定义、约束规则、触发条件为准，RFC 提供设计动机与背景叙事。

本 Spec 不覆盖 B 方向的非职责范围：ContextPack、任务调度、Agent 间通信协议、Checkpoint、Gate。这些分别由对应方向负责。

## **2\. 核心概念定义**

### **2\.1 Persona（人物画像）**

Persona 是 Agent 的**当前能力快照**，由离线 LLM 定期对 Agent 的全部 Experience 和 Skills 做归纳生成。它不是预设的角色定义，而是随时间演化的动态描述。

**对外用途**：帮助用户快速了解该 Agent 擅长什么，决定是否手动指定 Agent 执行任务。

**对内用途**：让 Agent 在认领任务时进行竞争力自评（"这个任务我擅长吗"）。

Persona 在顶层 LLM context 中常驻（约 200 tokens），版本化存储，每次重新归纳后生成新版本，旧版本保留为历史快照。

### **2\.2 Skill（技能）**

Skill 是**经过充分验证、趋于稳定的可复用能力单元**。它由高置信度 Experience（confidence \> 0\.95）晋升而来，需要经过审核（自动化或人工），支持跨 Agent 复用（进入技能市场），具有版本控制。

Skill 与 Experience 的核心区别：Experience 是 Agent 个体的"记忆笔记"，未经审核、不可跨 Agent 复用；Skill 是"经过质量闸门的可靠知识"，可被其他 Agent 引入。

### **2\.3 Experience（经验）**

Experience 是 Agent 在每次任务完成后，由顶层 LLM（离线模式）从 Driver 的 6 字段报告中反思提取的**结构化知识记录**。每条经验包含触发场景、方案摘要、关键决策、结果、置信度。

经验分为**正经验**和**负经验**：

- 正经验记录成功的方案复用路径，置信度随验证次数上升。

- 负经验记录失败教训，不单独存储，而是挂载到被引用的正经验上（`linked_negative_exp`），在检索正经验时作为警告同时命中。

### **2\.4 In\-context（工作记忆）**

In\-context 是顶层 LLM 在执行阶段的上下文工作区。它通过通用的上下文压缩方案（滑动窗口、对话摘要）管理，**不参与经验提取**。

In\-context 包含：Persona（常驻）、当前任务描述（随任务加载）、检索到的 Experience descriptions（top\-K 列表，不含完整 content）、对话/思考记录（滑动窗口管理）、上下文压缩区（旧对话的结构化摘要）。

### **2\.5 Out\-of\-context（缓冲区）**

Out\-of\-context 是**经验提取的原材料暂存区**，采用**方案2（膨胀派）**：同时存储 Driver 的 6 字段结构化报告和清理后的顶层 Agent 上下文快照（CoordinatorSnapshot）。顶层 LLM（离线模式）同时从两份原材料中提取经验。

**核心设计**：Agent 单次任务结束后，系统接管顶层 Agent 的完整上下文，执行上下文清理（Context Cleaning）：

\- **保留**：顶层 Agent 的思考过程（reasoning / thinking chains）和计划过程（task decomposition / planning）

\- **保留**：顶层 Agent 下发 Driver 的工具调用，以及对应的 Driver 6 字段报告（拼接在 Driver 调用之后）

\- **移除**：其他工具调用及其对应结果（如 \`experience\.query\`、\`skill\.market\_search\`、日志记录等机械性操作）

\- **移除**：中间环节的对话碎片、不完整的思考片段、重复内容、系统级重试的中间尝试

清理后的上下文封装为 CoordinatorSnapshot，与 BufferSnapshot（含 DriverReturn）成对写入 `pending/`。两份原材料在提取时相互补充：DriverReturn 提供结构化的执行结果，CoordinatorSnapshot 提供顶层 Agent 的意图、判断和上下文（"当时是怎么规划的"、"决策的依据是什么"）。

## **3\. 数据契约 — 实体字段定义**

### **3\.1 Persona — PersonaDef**

| 字段                  | 类型                | 必填 | 说明                              | RFC 状态 |
| --------------------- | ------------------- | ---- | --------------------------------- | -------- |
| `role_id`             | string              | ✅   | 所属 Agent 标识                   | 已明确   |
| `version`             | number              | ✅   | 版本号，每次归纳递增              | 已明确   |
| `summary`             | string              | ✅   | 专长领域归纳（≤200 tokens）       | 已明确   |
| `skills_overview`     | string              | ✅   | 掌握技能概览                      | 已明确   |
| `experience_coverage` | string              | ✅   | 经验覆盖范围                      | 已明确   |
| `recent_performance`  | string              | ✅   | 近期表现（成功率/任务数）         | 已明确   |
| `notes`               | string              | ✅   | 注意事项（如"OS 层安全经验尚缺"） | 已明确   |
| `generated_at`        | string \(ISO 8601\) | ✅   | 生成时间戳                        | 已明确   |

### **3\.2 Skill — SkillRecord**

| 字段名                  | 类型                      | 必填 | 说明                                                      | 状态       |
| ----------------------- | ------------------------- | ---- | --------------------------------------------------------- | ---------- |
| `id`                    | string \(UUID\)           | ✅   | 唯一标识                                                  | 已明确     |
| `description`           | string                    | ✅   | 短描述（≤3 句话，领域通用）                               | 已明确     |
| `description_embedding` | vector                    | ✅   | 描述向量，仅供检索，不对外暴露                            | 已明确     |
| `content`               | string                    | ✅   | 完整技能内容（步骤 \+ 参数 \+ 注意事项格式）              | 已明确     |
| `version`               | string \(semver\)         | ✅   | 语义化版本号                                              | 已明确     |
| `review_status`         | enum                      | ✅   | `pending` / `approved` / `rejected`                       | 已明确     |
| `sub_skills`            | string\[\]                | 否   | 子技能列表                                                | 已明确     |
| `tags`                  | string\[\]                | ✅   | 领域标签                                                  | 已明确     |
| `promoted_from`         | string \(experience\_id\) | 否   | 来源经验 ID                                               | 已明确     |
| `promoted_at`           | string \(ISO 8601\)       | ✅   | 晋升时间                                                  | 已明确     |
| `agent_id`              | string                    | ✅   | 所属 Agent（分裂后可能变更）                              | 已明确     |
| `imported_by`           | string\[\]                | 否   | 引入此技能的 Agent ID 列表                                | **待补充** |
| `linked_negative_exp`   | string\[\]                | 否   | 关联负经验 ID（晋升时从原 Experience 继承）               | **待补充** |
| `market_status`         | enum                      | 否   | 市场中状态：`available` / `superseded` / `retired_unique` | **待补充** |
| `reviewed_by`           | string                    | 否   | 审核人/审核系统标识                                       | **待补充** |
| `reviewed_at`           | string \(ISO 8601\)       | 否   | 审核时间                                                  | **待补充** |

#### **SkillRecord —\`promoted\_from\`**

当一条 Skill 出了问题，需要回溯原始经验来排查。但这属于运维需求而非系统流程需求。为可选字段（nullable），仅用于调试溯源，不参与任何自动流程。

#### **SkillRecord —\`imported\_by\`**

用于记录哪些 Agent 引入了这个 Skill。退休决策树中有明确使用："`imported_by.length > 0` → 保留，ownership 转移至市场"。

#### **SkillRecord —\`reviewed\_by\` / \`reviewed\_at\`**

审核流程的触发：RFC 只说晋升时 `review_status = "pending"`，可以简化为全自动通过。

**建议**：

- `reviewed_by`：默认为 `"system"`（自动审核），人工介入时改为审核人标识

- `reviewed_at`：ISO 8601，审核通过时写入

- 自动化规则：`confidence > 0.95` 且晋升的 Skill 在市场中无 ≥ 0\.80 相似度冲突时，自动 `approved`。否则保持 `pending`，等人工判断

### **3\.3 Experience — ExperienceRecord**

| 字段                    | 类型                                    | 必填 | 说明                                             | RFC 状态   |
| ----------------------- | --------------------------------------- | ---- | ------------------------------------------------ | ---------- |
| `id`                    | string \(UUID\)                         | ✅   | 唯一标识                                         | 已明确     |
| `description`           | string                                  | ✅   | 短描述（≤3 句话，领域通用、项目无关）            | 已明确     |
| `description_embedding` | vector                                  | ✅   | 描述向量，仅供检索                               | 已明确     |
| `content`               | string                                  | ✅   | 完整经验内容（场景 \+ 方案 \+ 关键决策 \+ 假设） | 已明确     |
| `confidence`            | number \(0\.0–1\.0\)                    | ✅   | 置信度，初始 0\.3                                | 已明确     |
| `tags`                  | string\[\]                              | ✅   | 领域标签                                         | 已明确     |
| `agent_id`              | string                                  | ✅   | 所属 Agent                                       | 已明确     |
| `linked_negative_exp`   | string\[\] \(exp\_id\)                  | 否   | 关联的负经验 ID 列表                             | 已明确     |
| `promoted_to`           | string \(skill\_id\)                    | 否   | 若已晋升，指向对应的 skill\_id                   | 已明确     |
| `assumptions`           | string\[\]                              | 否   | 假设与边界条件                                   | 已明确     |
| `confidence_history`    | Array\<\{value, updated\_at, reason\}\> | ✅   | 置信度变更历史                                   | 已明确     |
| `referenced_count`      | number                                  | ✅   | 被引用次数                                       | 已明确     |
| `last_referenced_at`    | string \(ISO 8601\)                     | 否   | 最近一次被引用时间                               | 已明确     |
| `source_task_id`        | string                                  | ✅   | 来源任务 ID                                      | 已明确     |
| `source_driver`         | string                                  | ✅   | 来源 Driver 标识                                 | 已明确     |
| `source_user_rating`    | string                                  | 否   | 来源任务的用户评分                               | **待补充** |
| `type`                  | enum                                    | ✅   | `positive` / `negative`                          | **待补充** |
| `created_at`            | string \(ISO 8601\)                     | ✅   | 创建时间                                         | **待补充** |
| `updated_at`            | string \(ISO 8601\)                     | ✅   | 最后更新时间                                     | **待补充** |

#### **ExperienceRecord —\`source\_user\_rating\`**

统一为用户评分枚举：`"resolved"` / `"partially_resolved"` / `"unresolved"` / `"not_rated"`。中文映射留在 UI 层。

#### **ExperienceRecord —\`type\`**

增加 `type: "positive" | "negative"`，必填。正经验的 `linked_negative_exp` 可非空（被负经验关联），负经验的 `linked_negative_exp` 为空（负经验本身不关联其他负经验）。

#### **ExperienceRecord —\`created\_at\` / \`updated\_at\`**

**建议**：秒级精度足够，ISO 8601 格式。\`created\_at\` 在经验首次插入时写入，\`updated\_at\` 在每次置信度变更或去重合并时更新。

### **3\.4 Driver 返回报告 — DriverReturn**

| 字段                     | 类型                                                        | 必填 | 说明                     | RFC 状态 |
| ------------------------ | ----------------------------------------------------------- | ---- | ------------------------ | -------- |
| `artifacts`              | Array\\\<\{type, path, summary\}\>                          | ✅   | 产物列表                 | 已明确   |
| `summary`                | string                                                      | ✅   | 执行摘要（3–5句话）      | 已明确   |
| `decisions`              | Array\\\<\{point, options, chosen, reason\}\>               | ✅   | 关键决策点（最重要字段） | 已明确   |
| `blockers`               | Array\\\<\{blocker, attempts, resolution, resolved\}\>      | ✅   | 卡点与解决               | 已明确   |
| `referenced_experiences` | Array\\\<\{experience\_id, applied, effectiveness, note\}\> | ✅   | 引用经验表现反馈         | 已明确   |
| `assumptions`            | Array\\\<\{assumption, risk\_if\_wrong\}\>                  | ✅   | 假设与边界               | 已明确   |

### **3\.5 缓冲区 — BufferSnapshot / BufferMeta**

**BufferSnapshot**（单条报告进入缓冲区时的快照）：

| 字段                       | 类型                | 必填 | 说明                                                                                | RFC 状态   |
| -------------------------- | ------------------- | ---- | ----------------------------------------------------------------------------------- | ---------- |
| `task_id`                  | string              | ✅   | 任务标识                                                                            | 已明确     |
| `task_description`         | string              | ✅   | 任务描述原文                                                                        | 已明确     |
| `user_rating`              | string              | 否   | 用户评分                                                                            | 已明确     |
| `driver_return`            | DriverReturn        | ✅   | Driver 的 6 字段报告                                                                | 已明确     |
| `source_task_id`           | string              | ✅   | 来源任务 ID                                                                         | 已明确     |
| `source_driver`            | string              | ✅   | 执行 Driver 标识                                                                    | 已明确     |
| `coordinator_snapshot_ref` | string \(seq\)      | 否   | 配对 CoordinatorSnapshot 的序列号（`context_{seq}.json`），缺失时表明上下文清理失败 | 待补充     |
| `received_at`              | string \(ISO 8601\) | ✅   | 报告接收时间                                                                        | **待补充** |
| `retry_count`              | number              | ✅   | 提取重试次数（默认 0）                                                              | **待补充** |
| `extraction_status`        | enum                | ✅   | `pending` / `processing` / `processed` / `dead_letter`                              | **待补充** |

#### **BufferSnapshot —\`received\_at\` / \`retry\_count\` / \`extraction\_status\`**

- `received_at`：报告进入 pending/ 的时间戳

- `retry_count`：提取失败后的重试次数，默认 0，最大 MAX\_RETRIES \(3\)

- `extraction_status`：`pending` → `processing`（被提取进程锁定）→ `processed`（提取成功）或回到 `pending`（失败且未超限）或 `dead_letter`（超限）

状态机如下：

```Plain Text
pending ──提取开始──▶ processing ──成功──▶ processed
  ▲                      │
  │                      └──失败且 retry_count < 3──▶ pending (retry_count++)
  │
  └──失败且 retry_count ≥ 3──▶ dead_letter
```

**BufferMeta**（缓冲区元数据）：

| 字段                                  | 类型                | 必填 | 说明               | RFC 状态   |
| ------------------------------------- | ------------------- | ---- | ------------------ | ---------- |
| `role_id`                             | number              | ✅   | 按agent区分存储    |            |
| `pending_count`                       | number              | ✅   | 待处理报告数       | 已明确     |
| `last_extraction_at`                  | string \(ISO 8601\) | 否   | 上次提取时间       | 已明确     |
| `last_extraction_report_count`        | number              | 否   | 上次消费的报告数   | 已明确     |
| `last_extraction_experiences_created` | number              | 否   | 上次创建的经验数   | 已明确     |
| `cursor`                              | number              | ✅   | 最后处理的报告序号 | 已明确     |
| `total_processed`                     | number              | ✅   | 累计已处理报告数   | **待补充** |
| `total_dead_letters`                  | number              | ✅   | 累计死信报告数     | **待补充** |

#### **BufferMeta —\`total\_processed\` / \`total\_dead\_letters\`**

每次报告成功移入 `processed/` 时 `total_processed++`，移入 `dead_letter/` 时 `total_dead_letters++`。只增不减，用于监控。

### 3\.5b **顶层上下文快照 — CoordinatorSnapshot**

CoordinatorSnapshot 是任务完成后，由系统对顶层 Agent 的完整上下文进行清理（Context Cleaning）后的结构化快照。它与 BufferSnapshot 成对写入缓冲区，为经验提取提供顶层 Agent 的意图和决策上下文。

**清理规则**（Context Cleaning）：

| 操作        | 内容类别                                   | 说明                                                                        |
| ----------- | ------------------------------------------ | --------------------------------------------------------------------------- |
| ✅ **保留** | 思考过程 \(reasoning / thinking chains\)   | 顶层 Agent 在规划、决策时的内部推理                                         |
| ✅ **保留** | 计划过程 \(task decomposition / planning\) | 任务分解、子目标设定、Driver 选择依据                                       |
| ✅ **保留** | Driver 调用工具定义 \+ 对应 DriverReturn   | Driver 下发的工具调用请求，并将对应的 BufferSnapshot\.report 拼接在调用后   |
| ❌ **移除** | 其他工具调用及其结果<br>                   | `experience.query`、`skill.market_search`、日志记录、元数据操作等机械性调用 |
| ❌ **移除** | 中间对话碎片                               | 不完整的思考片段、被覆盖的草稿、中断的半句话                                |
| ❌ **移除** | 重复内容<br>                               | 冗余的重述、系统级重试的中间尝试                                            |
| ❌ **移除** | 系统级噪声                                 | 上下文压缩摘要、token 管理提示、框架注入的元信息                            |

**CoordinatorSnapshot 字段定义**：

| 字段                   | 类型                                                       | 必填   | 说明                                                                             | RFC 状态       |
| ---------------------- | ---------------------------------------------------------- | ------ | -------------------------------------------------------------------------------- | -------------- |
| `snapshot_id`          | string \(UUID\)                                            | ✅     | 快照唯一标识                                                                     | **待补充**     |
| `source_task_id`       | string                                                     | ✅     | 对应任务 ID                                                                      | 已明确         |
| `agent_id`             | string                                                     | ✅     | 顶层 Agent 标识                                                                  | **待补充**     |
| `thinking_trace`       | string                                                     | ✅     | 清理后保留的思考/推理过程（reasoning chains）                                    | **待补充**<br> |
| `planning_trace`       | string                                                     | ✅<br> | 清理后保留的计划/任务分解过程                                                    | **待补充**     |
| `driver_calls`         | Array\<\{call\_id, driver\_id, driver\_return\_ref\}\><br> | ✅<br> | 清理后保留的 Driver 调用记录，每条记录包含调用前上下文、对应的 DriverReturn 引用 | **待补充**<br> |
| `cleaned_at`           | string \(ISO 8601\)                                        | ✅     | 清理完成时间戳                                                                   | **待补充**     |
| `original_token_count` | number                                                     | ✅     | 清理前原始上下文 token 数                                                        | **待补充**     |
| `cleaned_token_count`  | number                                                     | ✅     | 清理后保留的 token 数                                                            | **待补充**     |
| `compression_ratio`    | number                                                     | ✅     | 压缩比 = cleaned\_token\_count / original\_token\_count                          | **待补充**<br> |

**存储路径**：\`/\{agent\_id\}/buffer/pending/context\_\{seq\}\.json\`

**与 BufferSnapshot 的关联**：

- BufferSnapshot 和 CoordinatorSnapshot 使用相同的 `seq` 编号（`report_{seq}.json` ↔ `context_{seq}.json`），成对写入 `pending/`

- BufferSnapshot 新增 `coordinator_snapshot_ref` 字段指向配对快照（可选，死信时可能缺失）

- 提取时，顶层 LLM（离线模式）同时消费两份原材料：DriverReturn 提供"做了什么"，CoordinatorSnapshot 提供"为什么这么做"

### **3\.6 Agent 管理 — AgentHandle**

| 字段               | 类型                | 必填 | 说明                                                                            | RFC 状态             |
| ------------------ | ------------------- | ---- | ------------------------------------------------------------------------------- | -------------------- |
| `role_id`          | string              | ✅   | 唯一标识                                                                        | 已明确               |
| `name`             | string              | ✅   | Agent 名称                                                                      | 已明确               |
| `persona`          | PersonaDef          | ✅   | 当前 Persona                                                                    | 已明确               |
| `skill_count`      | number              | ✅   | 技能数量                                                                        | 已明确               |
| `experience_count` | number              | ✅   | 经验数量                                                                        | 已明确               |
| `status`           | enum                | ✅   | `created` / `active` / `idle` / `draining` / `retired`                          | 已明确               |
| `created_at`       | string \(ISO 8601\) | ✅   | 创建时间                                                                        | 已明确               |
| `tags`             | string\[\]          | 否   | 初始标签                                                                        | 已明确               |
| `parent_agent_id`  | string              | 否   | 分裂来源 Agent ID                                                               | **待 B 负责人补充**  |
| `retired_at`       | string \(ISO 8601\) | 否   | 退休时间                                                                        | **待 B 负责人补充**  |
| `retired_reason`   | enum                | 否   | `performance_degradation` / `inactivity` / `persona_drift` / `manual` / `split` | **待 B 负责人补充**  |
| `owned_skills`     | skill               | ✅   | 维护当前 Agent 所拥有的 skill                                                   | 定义较明确，无需多言 |
| `owned_exps`       | experience          | ✅   | 维护当前 Agent 所拥有的 experience                                              | 定义较明确，无需多言 |
| `metric`           | metric              | ✅   | 维护当前 Agent 的指标信息                                                       | 定义较明确，无需多言 |

#### **AgentHandle —\`owned\_skills\` / \`owned\_exps\` / \`metric**

这是合理的工程考量——AgentHandle 作为 Agent 的聚合根，应该能直接导航到其拥有的子实体。

- `owned_skills: string[]` — Skill ID 列表

- `owned_exps: string[]` — Experience ID 列表

- `metric` — 直接内嵌 AgentMetrics，或存 `metric_ref: string` 指向独立存储的 Metrics

其中 `skill_count` / `experience_count` 可由 `owned_skills.length` / `owned_exps.length` 推导（缓存为冗余字段也行）。

### **3\.7 创建 Agent 输入 — CreateAgentSpec**

| 字段           | 类型       | 必填 | 说明              | RFC 状态 |
| -------------- | ---------- | ---- | ----------------- | -------- |
| `role_id`      | string     | ✅   | 预设唯一标识      | 已明确   |
| `name`         | string     | ✅   | Agent 名称        | 已明确   |
| `tags`         | string\[\] | 否   | 初始领域标签      | 已明确   |
| `persona_seed` | string     | 否   | 初始 Persona 描述 | 已明确   |
| `constraints`  | string\[\] | 否   | 硬约束            | 已明确   |

### **3\.8 Metrics — AgentMetrics**

**原始指标（持久化）**：

| 字段                   | 类型                | 说明                 | RFC 状态 |
| ---------------------- | ------------------- | -------------------- | -------- |
| `role_id`              | string              | Agent 标识           | 已明确   |
| `total_tasks`          | number              | 总任务数             | 已明确   |
| `tasks_bid`            | number              | 竞标次数             | 已明确   |
| `tasks_won`            | number              | 中标次数             | 已明确   |
| `tasks_completed`      | number              | 完成任务数           | 已明确   |
| `tasks_succeeded`      | number              | 完全成功数           | 已明确   |
| `tasks_partial`        | number              | 部分成功数           | 已明确   |
| `tasks_failed`         | number              | 失败数               | 已明确   |
| `skill_count`          | number              | 技能数（快照）       | 已明确   |
| `experience_count`     | number              | 经验数（快照）       | 已明确   |
| `imported_skill_count` | number              | 引入技能数           | 已明确   |
| `promoted_skill_count` | number              | 自晋升技能数         | 已明确   |
| `avg_confidence`       | number              | 平均置信度           | 已明确   |
| `token_cost_total`     | number              | token 总开销         | 已明确   |
| `first_task_at`        | string \(ISO 8601\) | 首次任务时间         | 已明确   |
| `last_task_at`         | string \(ISO 8601\) | 最近任务时间         | 已明确   |
| `last_won_at`          | string \(ISO 8601\) | 最近中标时间         | 已明确   |
| `persona_version`      | number              | Persona 当前版本号   | 已明确   |
| `persona_drift`        | number              | Persona 漂移度量     | 已明确   |
| `persona_stable_since` | string \(ISO 8601\) | Persona 稳定起始时间 | 已明确   |

**派生指标（实时计算，不持久化）**：

| 指标                 | 公式                                      | 说明       |
| -------------------- | ----------------------------------------- | ---------- |
| `success_rate`       | `tasks_succeeded / tasks_completed`       | 任务成功率 |
| `bid_win_rate`       | `tasks_won / tasks_bid`                   | 中标率     |
| `experience_density` | `experience_count / total_tasks`          | 经验密度   |
| `skill_density`      | `skill_count / experience_count`          | 技能密度   |
| `activity_score`     | `1.0 / (1.0 + days_since_last_task / 14)` | 活跃度     |

### **3\.9 经验提取结果 — ExtractResult**

| 字段                   | 类型   | 说明             | RFC 状态 |
| ---------------------- | ------ | ---------------- | -------- |
| `experiences_created`  | number | 新创建的经验数   | 已明确   |
| `experiences_updated`  | number | 置信度调整数     | 已明确   |
| `negative_experiences` | number | 新生成的负经验数 | 已明确   |
| `skills_promoted`      | number | 晋升的技能数     | 已明确   |

### **3\.10 经验溯源 — ExperienceSource**

| 字段                 | 类型                                      | 说明           | RFC 状态 |
| -------------------- | ----------------------------------------- | -------------- | -------- |
| `experience_id`      | string                                    | 经验 ID        | 已明确   |
| `source_task_id`     | string                                    | 来源任务 ID    | 已明确   |
| `source_driver`      | string                                    | 来源 Driver    | 已明确   |
| `source_artifacts`   | Array\\\<\{type, path, summary\}\>        | 来源产物       | 已明确   |
| `source_user_rating` | string                                    | 用户评分       | 已明确   |
| `source_assumptions` | string\[\]                                | 假设列表       | 已明确   |
| `confidence_history` | Array\\\<\{value, updated\_at, reason\}\> | 置信度变更历史 | 已明确   |

### 3\.11 **运行时编排 — Agent / AgentManager（6月20日新增）**

Agent 运行时由两个核心类构成：**Agent**（单个 Agent 执行单元）和 **AgentManager**（Agent 管理器，负责生命周期与任务派发）。它们负责 Agent 实例在内存中的状态管理、任务竞标与执行循环，与持久化的 AgentHandle（§3\.6）互补——后者是存库的聚合根视图，前者是运行时的实体行为。

#### 3\.11\.1 **Agent 状态机 — AgentLoopState**

Agent 执行循环的生命周期由四态状态机管理：

```Plain Text
┌─────────────────────────────────┐
             │            startLoop()           │
    ┌────────▼────────┐                  ┌──────┴──────┐
    │     sleeping     │ ◄─── runOnce() ──►   running    │
    └────────┬────────┘     (任务完成)    └─────────────┘
             │ wake()                              ▲
    ┌────────▼────────┐                              │
    │      idle       │ ──── bid() → runOnce() ──────┘
    └────────┬────────┘
             │ stop()
    ┌────────▼────────┐
    │     stopped      │
    └─────────────────┘
```

| 状态       | 说明                              | 入口                                                              |
| ---------- | --------------------------------- | ----------------------------------------------------------------- |
| `idle`     | 初始/空闲态，可接受任务或进入休眠 | 构造后默认、`wake()` 从 sleeping 转入                             |
| `sleeping` | 休眠等待派单，不参与竞标          | `startLoop()` 从 idle 转入、`runOnce()` 任务完成自动回到 sleeping |
| `running`  | 任务执行中，不响应新请求          | `runOnce()` 开始时转入                                            |
| `stopped`  | 永久停止，不再参与任何循环        | `stop()` 从任何活跃态转入                                         |

#### 3\.11\.2 **Agent 运行时 — Agent（目前在mvp阶段，方法定义尚不完整）**

Agent 是单个 Agent 实例的运行时封装，通过 `role_id` 关联持久化存储中的 AgentHandle。每个 Agent 持有自己的 `MemoryRepository` 引用用于读写自身数据。

| 方法        | 签名                                          | 说明                                                          |
| ----------- | --------------------------------------------- | ------------------------------------------------------------- |
| `getState`  | `() => AgentLoopState`                        | 返回当前状态                                                  |
| `getHandle` | `() => Promise<AgentHandle>`                  | 从 repository 拉取聚合根视图                                  |
| `startLoop` | `() => void`                                  | 进入工作循环（sleeping），等待 Manager 调度                   |
| `wake`      | `() => void`                                  | 被 Manager 唤醒，转为 idle 准备竞标                           |
| `stop`      | `() => void`                                  | 永久停止，不再参与循环                                        |
| `bid`       | `(task: AgentTaskRequest) => Promise<number>` | 对任务自评，返回竞标分数（MVP 返回固定 0\.5）                 |
| `runOnce`   | `(task: AgentTaskRequest) => Promise<void>`   | 执行一轮任务（MVP 占位，后续接 Driver \+ writePendingBuffer） |

**AgentTaskRequest**（任务请求参数，仅在运行时内存中传递，不入库）：

| 字段                       | 类型       | 必填              | 说明                                       |
| -------------------------- | ---------- | ----------------- | ------------------------------------------ |
| `spec`                     | string     | ✅                | 任务规格说明文本（自然语言 \+ 结构化指令） |
| `scenario`                 | `"default" | "promotion_ready" | "promotion_blocked"`                       | 否  | 测试/演示场景标记，控制行为分支 |
| `demo_confidence_override` | number     | 否                | Demo 模式覆盖经验置信度，仅测试使用        |

#### 3\.11\.3 A**gentManager — Agent 管理器（Boss）**

AgentManager 负责管理所有 Agent 实例的完整生命周期：创建、启动、任务派发与退役。它不直接读写各 Agent 的缓冲区，而是通过竞标（bidding）机制选择最优 Agent 执行任务。

| 方法               | 签名                                                       | 说明                                                           |
| ------------------ | ---------------------------------------------------------- | -------------------------------------------------------------- |
| `create`           | `(repository) => AgentManager`                             | 静态工厂方法                                                   |
| `createAgent`      | `(spec: CreateAgentSpec) => Promise<AgentHandle>`          | 注册新 Agent 并纳入管理；若 Manager 已启动则自动 `startLoop()` |
| `start`            | `() => void`                                               | 启动 Manager，所有已注册 Agent 进入 sleeping                   |
| `stop`             | `() => void`                                               | 停止 Manager，通知所有 Agent 停止                              |
| `wakeAll`          | `() => void`                                               | 唤醒所有 Agent，转入 idle 准备竞标                             |
| `submitTask`       | `(request: AgentTaskRequest) => Promise<SubmitTaskResult>` | 发布任务：唤醒 → 竞标 → 中标者 runOnce                         |
| `getAgent`         | `(role_id: string) => Agent                                | undefined`                                                     | 获取指定 Agent 实例 |
| `listAgentHandles` | `() => Promise<AgentHandle[]>`                             | 列出所有 Agent 的聚合根视图                                    |
| `retireAgent`      | `(role_id: string) => Promise<void>`                       | 退役 Agent（MVP 占位）                                         |

**任务派发流程**（submitTask）：

```Plain Text
submitTask(request)
  │
  ├── 1. wakeAll()              ── 所有 Agent 转为 idle
  ├── 2. await agent.bid(task)  ── 各 Agent 返回竞标分数
  ├── 3. pickWinner(scores)     ── 取最高分者为 winner
  └── 4. await winner.runOnce() ── 中标者执行任务
```

**SubmitTaskResult**：

| 字段             | 类型                     | 说明              |
| ---------------- | ------------------------ | ----------------- |
| `winner_role_id` | string                   | 中标 Agent 标识   |
| `scores`         | `Record<string, number>` | 各 Agent 竞标分数 |

#### 3\.11\.4 **数据契约关系**

```Plain Text
┌─────────────────────────────────────────────┐
│              持久化层 (schemas)                │
│  AgentHandle (§3.6)  CreateAgentSpec (§3.7)  │
│  AgentMetrics  (§3.8)  PersonaDef  (§3.1)    │
└────────────────────┬────────────────────────┘
                     │ MemoryRepository (port)
                     ▼
┌─────────────────────────────────────────────┐
│              运行时层 (runtime)                │
│                                             │
│  ┌──────────────┐     manages     ┌────────┐│
│  │ AgentManager │──────────┬─────►│  Agent  ││
│  │  (Boss)      │ 1       n │     │ (员工)  ││
│  └──────┬───────┘          │     └───┬────┘│
│         │ submitTask()     │         │      │
│         │                  │         │      │
│  ┌──────▼───────┐          │         │      │
│  │ 竞标 & 派发   │◄─────────┘         │      │
│  │ pickWinner   │                    │      │
│  └──────────────┘                    │      │
│                                      │      │
│         AgentTaskRequest (运行时 DTO)◄┘      │
└─────────────────────────────────────────────┘
```

- Agent 通过 `MemoryRepository` 端口读写持久化数据（AgentHandle、Metrics、缓冲区等）

- AgentManager 通过 Agent `bid()` / `runOnce()` 接口与 Agent 交互，不直接操作持久层

- AgentTaskRequest 是纯运行时 DTO，不进入持久化存储

## **4\. 数据流与晋升管道**

### **4\.1 总体数据流**

```Plain Text
任务发布
  → ① 检索长期记忆（Experience / Skills）
  → ② 选中的 content 加载到顶层 LLM 的 In-context
  → ③ 顶层 LLM 组装 prompt → 下发 Driver 执行
  → ④ 用户评分
  → ⑤a 任务结束 → 顶层 Agent context 移除，由系统接管
  → ⑤b 上下文清理（Context Cleaning）：移除无关工具调用与结果，保留思考/计划/Driver调用
  → ⑤c BufferSnapshot（DriverReturn）+ CoordinatorSnapshot（清理后上下文）成对写入缓冲区 (pending/)
  → ⑥ 缓冲区触发（容量/时间/优先级门控）
  → ⑦ 顶层 LLM（离线模式）消费 BufferSnapshot + CoordinatorSnapshot → 提取 Experience
  → ⑧ Experience 入库（长期记忆）
  → ⑨ confidence > 0.95 → 晋升为 Skill（长期记忆，入技能市场）
  → ⑩ Skills 变化达到阈值 → Persona 重新归纳
```

### **4\.2 上下文捕获 → 缓冲区写入 → 经验提取（步骤⑤a→⑦）**

#### **4\.2\.1 上下文捕获与清理（步骤⑤a→⑤c）**

**步骤⑤a：任务结束，顶层 Agent context 移除**

Agent 单次任务执行完成后，系统立即将顶层 Agent 的完整上下文（In\-context）从 Agent 实例中移除并接管。此时 Agent 实例变为"空白"状态，等待下一个任务的 In\-context 加载。被移除的原始上下文（Raw Context）进入系统管道，后续处理不占用 Agent 实例资源。

**步骤⑤b：上下文清理（Context Cleaning）**

系统对原始上下文执行自动化清理，目标是**保留决策价值，去除执行噪声**：

| 步骤 | 操作                                                      | 判定依据                                                                                                                     |
| ---- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| C1   | 识别并保留思考/推理片段                                   | 模式匹配：`<thinking>` / `[REASONING]` 标记，或 LLM 内部思考标记                                                             |
| C2   | 识别并保留计划/任务分解片段                               | 模式匹配：任务分解列表、子目标声明、Driver 选择理由                                                                          |
| C3   | 保留 Driver 下发的工具调用定义                            | 检测 `agent.dispatch_driver(...)` 或等价的 Driver 调用工具签名                                                               |
| C4   | 将 DriverReturn（6 字段报告）拼接在对应 Driver 调用后<br> | 通过 `source_task_id` 关联，将 BufferSnapshot 的 `driver_return` 内容追加到 `driver_calls[].driver_return_ref`               |
| C5   | 移除其他工具调用及结果                                    | 过滤 `experience.query`、`skill.market_search`、`agent.get_persona`、`log.write`、`metric.record` 等非 Driver 调用的工具交互 |
| C6   | 移除中间对话碎片                                          | 不完整句子、被覆盖的草稿、中断重新生成的前半部分                                                                             |
| C7   | 移除重复内容                                              | 相似度 \> 0\.90 的相邻段落（LLM 重复输出），保留首次出现                                                                     |
| C8   | 移除系统级噪声                                            | 上下文压缩摘要注入、token 管理提示、滑动窗口边界标记                                                                         |

**清理后的产出**：CoordinatorSnapshot（字段定义见 3\.5b），写入 \`/\{agent\_id\}/buffer/pending/context\_\{seq\}\.json\`。

**清理失败处理**：如果清理过程失败（如原始上下文不可读），\`coordinator\_snapshot\_ref\` 留空，BufferSnapshot 仍正常写入。提取时仅使用 DriverReturn——降级回方案 1。

**步骤⑤c：成对写入 pending/**

DriverReturn 封装为 BufferSnapshot（`report_{seq}.json`），CoordinatorSnapshot（`context_{seq}.json`）与之使用相同的 `seq` 编号，成对写入 `/{agent_id}/buffer/pending/`。buffer\_meta\.json 的 `pending_count` 递增（一组 = 1 个 pending\_count，即使它包含两个文件），`cursor` 不更新。

#### **4\.2\.2 缓冲区触发门控（步骤⑥）**

**缓冲区触发门控（三层，由廉到贵）**：

| 层级           | 条件                                                                    | 优先级 |
| -------------- | ----------------------------------------------------------------------- | ------ |
| 1\. 容量门控   | `pending_count ≥ BATCH_SIZE`（默认 3）                                  | 常规   |
| 2\. 时间门控   | `pending` 中最老报告距今 ≥ `MAX_STALENESS`（默认 6 小时）               | 常规   |
| 3\. 优先级门控 | 存在 `effectiveness = "ineffective"` 或 `user_rating = "未解决"` 的报告 | 最高   |

满足任一条件 → 触发经验提取。

#### **4\.2\.3 经验提取过程（步骤⑦）**

1. 锁定缓冲区（文件锁 \+ PID 存活检查，1 小时超时自动释放）

2\. 将待处理报告**及其配对 CoordinatorSnapshot** 从 \`pending/\` 移入 \`processing/\`

3\. 消费每条 BufferSnapshot 时，**同时加载配对 CoordinatorSnapshot**：

- 顶层 LLM 阅读 DriverReturn 的 `decisions`、`blockers`、`assumptions` 等字段（"做了什么"）

- 顶层 LLM 阅读 CoordinatorSnapshot 的 `thinking_trace`、`planning_trace`、`driver_calls` 等字段（"为什么这么做"）

\- 两份原材料**相互补充**：DriverReturn 提供结构化的执行结果证据，CoordinatorSnapshot 提供顶层 Agent 的意图、规划逻辑和 Driver 选择上下文

4\. **双源提取增强**（相比方案 1 新增的能力）：

\- **意图\-结果对齐**：对比 \`planning\_trace\` 中的计划与 DriverReturn\.\`summary\` 中的实际执行结果，识别"计划偏差" → 生成更丰富的经验

\- **上下文依赖识别**：从 \`context\_before\_task\` 和 \`thinking\_trace\` 中提取"当时依赖的假设和前提"，丰富 Experience\.\`assumptions\`

\- **跨任务模式发现**：多条 CoordinatorSnapshot 的 \`planning\_trace\` 中反复出现的策略 → 更可靠的晋升候选

5. 遵循四个提取原则（执行者无关、保留决策非操作、提取可迁移模式、负经验关联正经验）

6. 去重检查：新经验的 `description_embedding` 与已有经验的余弦相似度 \> 0\.85 → 更新已有经验而非创建新经验

7. 根据 `referenced_experiences` 中的 `effectiveness` 调整置信度

8. 成功提取 → BufferSnapshot 和 CoordinatorSnapshot 成对移入 `processed/`；失败 → 两者 `retry_count + 1`，超过 `MAX_RETRIES`（默认 3）→ 移入 `dead_letter/`

9. 释放锁，更新 `buffer_meta.json`

**CoordinatorSnapshot 缺失时的降级**：如果 BufferSnapshot\.\`coordinator\_snapshot\_ref\` 为空（上下文清理失败），提取退化为方案 1 模式——仅从 DriverReturn 提取经验。

### **4\.3 Experience → Skills 晋升管道（步骤⑨）**

**触发条件**：Experience 的 \`confidence \> 0\.95\`。

**执行流程**：

1. `type` 从 `experience` 改为 `skill`

2. `content` 从经验格式（场景 \+ 方案 \+ 决策）重整为技能格式（步骤 \+ 参数 \+ 注意事项）

3. `description` 微调为更通用化的技能描述 → 重做 `description_embedding`

4. 清空 experience 专属 metadata（`confidence`、`linked_negative_exp` 等）

5. 初始化 skill 专属 metadata（`version = "1.0.0"`、`review_status = "pending"`）

6. 原始经验记录标记 `promoted_to = skill_id`，后续可选择删除以减少记忆载荷

**置信度升降规则**（在经验被引用后，根据 Driver 反馈的 \`effectiveness\` 调整）：

| effectiveness         | 置信度变化                    |
| --------------------- | ----------------------------- |
| `fully_effective`     | \+0\.10                       |
| `partially_effective` | \+0\.05（记录适配注意事项）   |
| `ineffective`         | \-0\.15（同时触发负经验生成） |
| `not_applicable`      | 不变（不计入引用次数）        |

### **4\.4 Skills \+ Experience → Persona 更新（步骤⑩）**

**触发条件**（满足任一）：

| 条件         | 阈值                                                         | 说明                           |
| ------------ | ------------------------------------------------------------ | ------------------------------ |
| 技能数变化   | Skills 新增 ≥ 3 或 Skills 减少 ≥ 2                           | 能力方向扩展/收窄              |
| 经验分布漂移 | 最近 N 条经验的 tags 分布与现有 Persona 的余弦相似度 \< 0\.6 | 成长方向变化                   |
| 定期触发     | 距上次归纳 ≥ 7 天 AND 有新经验产生                           | 常规更新                       |
| 强制刷新     | 距上次归纳 ≥ 30 天                                           | 即使无新经验也要刷新"近期表现" |

**执行方式**：离线 LLM 读取 Agent 的完整 Experience 库和 Skills 库，归纳生成新的 PersonaDef，version 递增，旧版本保留。

## **5\. 检索流程**

### **5\.1 检索/载荷分离（ReMe 模式）**

索引层（向量库，参与检索）和载荷层（JSON，注入 Driver prompt）分离：

```Plain Text
任务描述
  │
  ▼ embedding
索引层 top-K 查询 (K=20)
  ├── 过滤：agent_id, confidence ≥ 0.2, type
  └── 返回 top-K description 列表
  │
  ▼ 顶层 LLM 精筛
从 top-K 中选出最终 N 条（N ≤ 5）
  ├── 判断内容是否与当前任务直接相关
  ├── 排除重复/冗余
  └── 评估置信度是否可信
  │
  ▼ 载荷注入
拉取选中条目的 content
组装到 Driver prompt 的"参考经验/技能"部分
```

**负经验关联检索**：检索到一条正经验时，自动拉取其 \`linked\_negative\_exp\` 指向的负经验 descriptions，一并注入 Driver prompt（作为"注意事项"）。

## **6\. 被其他方向引用的角色/记忆材料**

### **6\.1 Persona**

\- **引用方：方向 C（Agent 间通信/Scaffold）** — 当 Agent 需要 \`ask\_help\` 或 \`escalate\` 时，Scaffold 层需要查询目标 Agent 的 Persona 来判断"该求助谁"。

\- **引用方：任务市场** — Boss 发布任务时，任务市场需要读取各 Agent 的 Persona tags 和 summary 来辅助任务匹配和 Agent 竞争力估值。

\- **提供方式**：\`agent\.get\_persona\(role\_id\)\` 接口。

### **6\.2 Skills**

\- **引用方：技能市场（跨方向共享能力池）** — 其他 Agent 可以通过 \`skill\.market\_search\(\)\` 和 \`skill\.market\_import\(\)\` 检索并引入已晋升的技能。

\- **引用方：任务市场** — 竞争力估值公式中的 \`skill\_match\` 依赖 Agent 的 Skill tags 与任务 tags 的匹配度。

\- **提供方式**：\`skill\.market\_search\(query, opts\)\` 接口。

### **6\.3 Experience**

\- **外部不直接引用** — Experience 绑定 Agent，不可跨 Agent 复用。其他方向不直接访问 Experience，而是通过 Persona 和 Skills 间接感知 Agent 的能力。

\- **内部检索**：\`experience\.query\(role\_id, query, opts\)\` 接口仅供 B 方向内部使用。

### **6\.4 AgentHandle（Agent 状态）**

\- **引用方：任务市场** — 需要 \`agent\.list\(\)\` 查询所有活跃 Agent 及其状态（\`active\` / \`idle\` / \`draining\` / \`retired\`），以决定哪些 Agent 可以参与竞标。

\- **引用方：方向 C** — 需要知道哪些 Agent 在线，以便路由 \`agent\.message\` 等通信原语。

\- **提供方式**：\`agent\.list\(opts\)\` 接口。

### **6\.5 AgentMetrics**

\- **引用方：任务市场** — 竞争力估值公式的 \`quality\` 和 \`freshness\` 维度依赖 Metrics 数据。

\- **提供方式**：\`agent\.get\_metrics\(role\_id, period\)\` 接口。

### **6\.6 ExtractResult**

\- **内部消费** — 经验提取的结果由 B 方向内部使用，用于日志记录和 \`buffer\_meta\.json\` 更新。

\- **外部监听** — 方向 D（Hook/Gate 系统）可能需要监听 \`agent\.experience\_extracted\` 和 \`agent\.skill\_promoted\` Hook 事件（payload 取自 ExtractResult）。

### 6\.7 **查询接口与响应契约**

本节约定**读接口**对外返回的数据形态，供前端 AgentBoard§6\.1–§6\.6 描述「谁引用、逻辑接口名」；**字段语义以 §3 实体定义为准**，本节不重复全字段表，只约定接口拼装、对外可见性与示例 JSON。

**逻辑接口 → 实现映射**：

| 逻辑接口（§6\.7）        | `AgentBoardQuery` 方法     | 底层依赖                                  |
| ------------------------ | -------------------------- | ----------------------------------------- |
| `agent.list`             | `listAgents()`             | `MemoryRepository.getAgent` × N           |
| `agent.get`              | `getAgent(role_id)`        | 同上                                      |
| `agent.get_persona`      | `getPersona(role_id)`      | `getPersona`                              |
| `agent.get_metrics`      | `getMetrics(role_id)`      | `getMetrics` \+ `calculateDerivedMetrics` |
| `agent.list_skills`      | `listSkills(role_id)`      | `listSkills`                              |
| `agent.list_experiences` | `listExperiences(role_id)` | `listExperiences`                         |

#### 6\.7\.1 **agent\.list/agent\.get → AgentHandle**

**用途**：

- `listAgents()` — Board 列表卡片（轻量）

\- \`getAgent\(role\_id\)\` — Agent 详情页：**头部 \+ 画像 Tab \+ 指标 Tab** 一次拿齐（含 \`metrics\.derived\`）

**入参**

| 参数      | 类型   | 必填          | 说明       |
| --------- | ------ | ------------- | ---------- |
| `role_id` | string | 仅 `getAgent` | Agent 标识 |

**响应**：

| 方法                | 类型                   | 说明                                                             |
| ------------------- | ---------------------- | ---------------------------------------------------------------- |
| `listAgents()`      | `AgentBoardListItem[]` | 见 §6\.7\.4；仅摘要，不含 metrics / persona 全文                 |
| `getAgent(role_id)` | `AgentBoardAgentView`  | 见 §6\.7\.4；含完整 `persona` \+ `metrics`（`raw` \+ `derived`） |

**前端应用字段**：

- 列表：`role_id`、`name`、`status`、`tags`、`skill_count`、`experience_count`、`persona_summary`

**示例 — getAgent\(role\_id\)**：

```JSON
{
  "role_id": "role_ts_engineer",
  "name": "TypeScript Engineer",
  "status": "created",
  "created_at": "2026-06-24T03:00:00.000Z",
  "tags": ["typescript", "architecture"],
  "skill_count": 1,
  "experience_count": 3,
  "persona": {
    "role_id": "role_ts_engineer",
    "version": 1,
    "summary": "Senior TypeScript engineer for scaffold demos.",
    "skills_overview": "TypeScript interfaces, memory module patterns.",
    "experience_coverage": "Contract boundaries, retrieval pipelines.",
    "recent_performance": "Awaiting first task.",
    "notes": "Initialized by InMemoryRepository.",
    "generated_at": "2026-06-24T03:00:00.000Z"
  },
  "metrics": {
    "raw": {
      "role_id": "role_ts_engineer",
      "total_tasks": 12,
      "tasks_bid": 10,
      "tasks_won": 7,
      "tasks_completed": 11,
      "tasks_succeeded": 9,
      "tasks_partial": 1,
      "tasks_failed": 1,
      "skill_count": 1,
      "experience_count": 3,
      "imported_skill_count": 0,
      "promoted_skill_count": 1,
      "avg_confidence": 0.72,
      "token_cost_total": 125000,
      "first_task_at": "2026-06-01T08:00:00.000Z",
      "last_task_at": "2026-06-23T18:30:00.000Z",
      "last_won_at": "2026-06-23T18:30:00.000Z",
      "persona_version": 1,
      "persona_drift": 0.12,
      "persona_stable_since": "2026-06-15T00:00:00.000Z"
    },
    "derived": {
      "success_rate": 0.818,
      "bid_win_rate": 0.7,
      "experience_density": 0.25,
      "skill_density": 0.333,
      "activity_score": 0.82
    }
  }
}
```

#### 6\.7\.2 **agent\.list\_skills → SkillRecord\[\]**

**用途**：Agent 详情 — 技能列表 / 技能详情。

**入参**：\`role\_id\`（string，必填）

**响应**：\`SkillRecord\[\]\`（§3\.2），**剔除** \`description\_embedding\`。

**列表页常用字段**：\`id\`、\`description\`、\`tags\`、\`review\_status\`、\`version\`、\`promoted\_at\`。

**详情页额外展示**：\`content\`、\`promoted\_from\`、\`market\_status\`、\`reviewed\_by\`、\`reviewed\_at\`。

**示例**（单条）：

```JSON
{
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "description": "Write stable TypeScript interfaces for memory ports.",
  "content": "## Steps\n1. Define Zod schema in schemas.ts\n2. Export types from index.ts\n...",
  "version": "1.0.0",
  "review_status": "approved",
  "tags": ["typescript", "memory"],
  "promoted_from": "b2c3d4e5-f6a7-8901-bcde-f12345678901",
  "promoted_at": "2026-06-20T10:00:00.000Z",
  "agent_id": "role_ts_engineer",
  "market_status": "available",
  "reviewed_by": "system",
  "reviewed_at": "2026-06-20T10:05:00.000Z",
  "created_at": "2026-06-20T10:00:00.000Z",
  "updated_at": "2026-06-20T10:05:00.000Z"
}
```

**枚举**：

- `review_status`：`pending` \| `approved` \| `rejected`

- `market_status`：`available` \| `superseded` \| `retired_unique`

#### 6\.7\.3 **agent\.list\_experiences → ExperienceRecord\[\]**

**用途**：Agent 详情 — 经验列表 / 经验详情。

**入参**：\`role\_id\`（string，必填）

**响应：**\`ExperienceView\[\]\`（= \`ExperienceRecord\` §3\.3 的 Board 裁剪版，见 §6\.7\.4 \`ExperienceView\` 定义）。

**列表页常用字段**：\`id\`、\`description\`、\`confidence\`（0\~1）、\`tags\`、\`type\`、\`promoted\_to\`（有值表示已晋升）。

**详情页额外展示**：\`content\`、\`confidence\_history\`、\`source\_task\_id\`、\`source\_driver\`。

**示例**（单条）：

```JSON
{
  "id": "b2c3d4e5-f6a7-8901-bcde-f12345678901",
  "description": "Handle TypeScript contract boundaries in memory module.",
  "content": "Scenario: port/adapter split.\nDecision: keep retrieval in adapters.\nOutcome: clean separation.",
  "confidence": 0.85,
  "tags": ["typescript", "contracts"],
  "agent_id": "role_ts_engineer",
  "confidence_history": [
    { "value": 0.75, "updated_at": "2026-06-18T12:00:00.000Z", "reason": "extracted" },
    { "value": 0.85, "updated_at": "2026-06-22T09:00:00.000Z", "reason": "referenced fully_effective" }
  ],
  "referenced_count": 2,
  "last_referenced_at": "2026-06-22T09:00:00.000Z",
  "source_task_id": "task_mvp_001",
  "source_driver": "mock-driver",
  "source_user_rating": "resolved",
  "type": "positive",
  "created_at": "2026-06-18T12:00:00.000Z",
  "updated_at": "2026-06-22T09:00:00.000Z"
}
```

**枚举**：

- `type`：`positive` \| `negative`

- `source_user_rating`：`resolved` \| `partially_resolved` \| `unresolved` \| `not_rated`

#### 6\.7\.4 **AgentBoardQuery — AgentBoard 读门面**

**定位**：AgentBoard 与 BFF 的**唯一读入口**（Port \+ Service）。只读、不写；不替代 \`AgentManager\.submitTask\` 等写/执行路径。

**职责**：

1. 委托 `MemoryRepository` 读取 §3 实体；

2. 组装 对外 DTO（剔除 `description_embedding`）；

3. 在 **\`getAgent** 内组装 \`metrics\.raw\` \+ \`metrics\.derived\`（§3\.8，派生指标实时计算）；

**Port 方法契约（共 4 个）**：

| 方法              | 签名                                        | 响应类型       | 说明                                        |
| ----------------- | ------------------------------------------- | -------------- | ------------------------------------------- |
| `listAgents`      | `() => Promise<AgentBoardListItem[]>`       | Board 卡片列表 | 轻量摘要                                    |
| `getAgent`        | `(role_id) => Promise<AgentBoardAgentView>` | 详情页         | 含 `persona` \+ `metrics`（raw \+ derived） |
| `listSkills`      | `(role_id) => Promise<SkillView[]>`         | §6\.7\.4       | 按需加载；剔除 embedding                    |
| `listExperiences` | `(role_id) => Promise<ExperienceView[]>`    | §6\.7\.5       | 按需加载；剔除 embedding                    |

**AgentBoardListItem**（Board 列表卡片 DTO）：

| 字段               | 类型        | 来源                | 说明                     |
| ------------------ | ----------- | ------------------- | ------------------------ |
| `role_id`          | string      | AgentHandle         | Agent 标识               |
| `name`             | string      | AgentHandle         | 显示名                   |
| `status`           | enum        | AgentHandle         | 生命周期状态             |
| `tags`             | string\[\]? | AgentHandle         | 标签                     |
| `skill_count`      | number      | AgentHandle         | 技能数量（Board 展示用） |
| `experience_count` | number      | AgentHandle         | 经验数量（Board 展示用） |
| `persona_summary`  | string      | PersonaDef\.summary | 画像一句话摘要           |

**AgentBoardAgentView**（Board 详情 DTO，getAgent 响应）：

| 字段               | 类型              | 说明                                            |
| ------------------ | ----------------- | ----------------------------------------------- |
| `role_id`          | string            | Agent 标识                                      |
| `name`             | string            | 显示名                                          |
| `status`           | enum              | 生命周期状态                                    |
| `tags`             | string\[\]?       | 标签                                            |
| `skill_count`      | number            | 技能数量（Board 展示用）                        |
| `experience_count` | number            | 经验数量（Board 展示用）                        |
| `persona`          | `PersonaDef`      | 完整画像（§3\.1）；画像 Tab 直接用此字段        |
| `metrics`          | `MetricsResponse` | §6\.7\.3；指标 Tab 直接用此字段（含 `derived`） |
| `created_at`       | string            | 创建时间 ISO 8601                               |

Skills / Experiences **正文不在此对象中**；用户展开时调用 \`listSkills\` / \`listExperiences\`。

**SkillView** = SkillRecord（§3\.2）**去掉** description\_embedding。

**ExperienceView** = ExperienceRecord（§3\.3）**去掉** description\_embedding 与 **linked\_negative\_exp**

**与 AgentManager的关系**：AgentManager\`负责创建 Agent、派任务；Board **列表**在实现上可复用「已注册 Agent 的 \`role\_id\` 集合」（与 Manager 同源），但**读契约**不经过 Manager 对外暴露，统一走AgentBoardQuery。

## 7\.其它

### 7\.1 **向量库选型**

三个选项的对比在这个项目的语境下：

| 维度       | pgvector                    | Qdrant               | Milvus              |
| ---------- | --------------------------- | -------------------- | ------------------- |
| 部署复杂度 | PostgreSQL 扩展，零额外服务 | 独立服务，需单独部署 | 独立服务，组件多    |
| 规模适配   | 万级向量足够                | 百万级               | 亿级                |
| SQL 兼容   | 原生 SQL，与载荷 JSON 同库  | 独立 API             | 独立 API            |
| 适合场景   | 原型/中小规模               | 生产级语义搜索       | 大规模图像/视频检索 |

这个项目的规模是"每个 Agent 几十到几百条 Experience/Skill"，检索/载荷分离后索引层只存 `description_embedding`，总量不会超过万级。pgvector 的同库优势在这里很关键——索引层的 `description_embedding` 和载荷层的 JSON metadata 在同一张表里，一次查询就能拿到完整记录，不需要跨服务 JOIN。

**建议**：pgvector。单 PostgreSQL 实例承载索引层 \+ 载荷层 \+ buffer\_meta \+ agent 注册表全部数据。向量维度跟随 Embedding 模型（见下一条）。

### 7\.2 Embedding模型

核心约束就一条：**索引时和查询时必须用同一个模型**，否则余弦相似度无意义。在这个前提下，选择取决于两个因素：\(a\) 是否需要本地部署，\(b\) 向量维度。

选择取决于你们整体 LLM 栈是走 API 还是本地模型。但 Spec 层面不需要锁死具体模型名，只需要约定：

**建议**：Spec 中约定如下约束，具体模型由实现阶段选定：

- 向量维度在系统初始化时配置，索引层建表时按配置维度创建 `vector(N)` 列

- 索引和查询使用同一模型实例

- Description 在写入和检索前都经过同一次 embedding 调用

- 模型切换时需要全量重建索引（`description_embedding` 全部重算）

### 7\.3 **死信队列处置策略**

死信的定义：一条 BufferSnapshot 的 `retry_count ≥ MAX_RETRIES (3)` 且仍未提取成功。

死信的本质是"Driver 返回的 6 字段报告格式有问题，导致提取 LLM 无法消费"。可能的原因：报告残缺、字段类型不匹配、LLM 提取时抛出异常。

**建议的三层处置策略**：

| 层级    | 动作                                                                                                               | 触发条件                        |
| ------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| L1 自动 | 记录失败原因到报告 metadata，通知开发者                                                                            | `retry_count` 达到 3 时立即执行 |
| L2 定时 | 每 24 小时扫描 `dead_letter/`，对原因明确的死信尝试自动修复重试（如字段缺失可补默认值）                            | 定时任务                        |
| L3 降级 | 超过 7 天仍未修复的死信，归档并记录一条 `type="negative"` 的占位经验（仅标记"该任务未能提取经验"），释放缓冲区空间 | 定时任务                        |

这里有一个权衡：如果直接把死信丢弃，Agent 会丢失一次任务的学习机会。生成一条置信度 0\.1 的占位负经验至少保留了"这次任务发生过"的记录，后续同类任务检索时可以提示"上次类似场景未成功提取经验，需谨慎"。

### 7\.4 **缓冲区清理周期**

`processed/` 中的报告已经被萃取为 Experience，保留它们的唯一价值是审计溯源（`experience.get_source()` 接口需要原始报告）。

**建议**：

- `processed/`：7 天清理，合理。经验提取后 7 天内的溯源需求基本能覆盖。如果后续发现审计需求更高，可改为 30 天（磁盘开销很小，每条报告几 KB）

- `pending/`：不自动清理，只在提取成功后移入 `processed/`

- `dead_letter/`：30 天清理（给人足够时间人工检查），与上面的降级策略一致

- 所有清理操作记录到 `buffer_meta.json` 的 `total_cleaned` 字段

### 7\.5 **文件锁实现细节**

RFC 已约定的方案：文件锁（`.consolidate-lock`）\+ PID 存活检查 \+ 1 小时超时自动释放。

对于单实例场景（课程原型），这个方案完全够用。真正需要补充的是**多实例场景下的边界行为**，但那是生产化阶段的事。

**建议**：Spec 中按单实例设计，补充两个细节：

1. 锁文件路径：`/{agent_id}/buffer/.extraction-lock`，内容为 `{pid}\n{started_at_iso8601}`

2. 超时检查逻辑：新进程尝试获取锁时，如果锁文件存在 → 读取 PID → 检查进程是否存活 → 如果存活且 `now - started_at < 1h` → 等待重试；如果进程已死或超时 → 强制接管锁

### 7\.6 **分裂时 Skills 聚类算法参数**

RFC 已给出两个候选：HDBSCAN 和 Agglomerative Clustering。核心区别：

| 维度           | HDBSCAN                | Agglomerative Clustering |
| -------------- | ---------------------- | ------------------------ |
| 需要预设聚类数 | 不需要                 | 需要设 threshold         |
| 噪声点处理     | 自动标记噪声（不归类） | 所有点强制归类           |
| 确定性         | 非确定性（有随机种子） | 确定性                   |
| 适合场景       | 探索性分析             | 参数明确的生产流程       |

分裂是一个**生产流程**，不是探索性分析。触发条件已经通过第一层和第二层做了严格的预筛选（skills 数量 ≥ 15、tags 基数 ≥ 4、聚类间相似度 \< 0\.4），到第三层只需要确定性执行。HDBSCAN 的非确定性和噪声点标记会引入不必要的复杂性——分裂后如果有 Skills 被标记为噪声而不分配给任何子 Agent，这条 Skill 就丢了。

**建议**：使用 Agglomerative Clustering，参数如下：

| 参数                 | 值        | 说明                                                                                       |
| -------------------- | --------- | ------------------------------------------------------------------------------------------ |
| `metric`             | `cosine`  | 与 description\_embedding 的检索方式一致                                                   |
| `distance_threshold` | `0.6`     | 对应相似度 0\.4（distance = 1 \- similarity），与 RFC 的 `SPLIT_SIMILARITY_THRESHOLD` 一致 |
| `linkage`            | `average` | 对聚类形状没有先验假设，average 是最稳妥的选择                                             |
| `min_cluster_size`   | `3`       | 与 RFC 的 `MIN_SPLIT_SIZE` 一致                                                            |

执行时的保护条件：聚类结果必须满足"聚类数 ≥ 2 且每个聚类 ≥ 3 个 skill"，否则不分裂。

### **7\.7\. 退休时技能市场处置决策树**

RFC 原文逻辑（对每条 Skill）：

```Plain Text
市场中相似度 > 0.80    → 不保留，标记 superseded
imported_by.length > 0  → 保留，ownership 转移至市场
review_status = approved → 保留
review_status = pending  → 触发审核
review_status = rejected → 不保留
市场中最相似 < 0.70     → 保留并标记 "retired_unique"，提高推荐优先级
linked_neg 占比 > 0.3   → 保留但附加警告标记
```

**边界 case 与补充规则**：

| 边界 case                                              | 问题                                                                                          | 补充规则                                                                                                                                                                                                                            |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 一条 Skill 同时命中多条规则                            | 优先级冲突。例如：市场中相似度 = 0\.85 应该 superseded，但 imported\_by\.length \> 0 应该保留 | **优先级顺序**：`review_status = rejected`（最高，直接丢弃）→ `review_status = approved`（保留）→ `imported_by.length > 0`（保留）→ 相似度 \> 0\.80（superseded）→ 相似度 \< 0\.70（retired\_unique）→ 其余（保留 \+ pending 审核） |
| `linked_neg` 占比 \> 0\.3 但 review\_status = approved | 已经 approved 的 skill 有高负经验占比，说明审核可能有问题                                     | 保留但 `market_status` 加 `warning` 标记，不改变 review\_status                                                                                                                                                                     |
| 市场中没有任何相似 Skill                               | 与 "最相似 \< 0\.70" 等价                                                                     | 归入 retired\_unique 分支                                                                                                                                                                                                           |
| pending 审核触发后无人处理                             | Skill 悬在 pending 状态                                                                       | 30 天超时：自动标记 `rejected`，不保留                                                                                                                                                                                              |

### 7\.8 **审核自动化规则**

Skill 晋升后 `review_status = "pending"`。什么条件可以自动变为 `approved`？

**建议的自动审核规则**：

满足以下全部条件时，自动 `approved`：

1. 晋升来源 Experience 的 `confidence ≥ 0.97`（比晋升门槛 0\.95 再高一点，留安全边际）

2. 技能市场中不存在相似度 ≥ 0\.80 的已有 Skill（避免重复技能入库）

3. 晋升来源 Experience 的 `linked_negative_exp` 占比 ≤ 0\.2（负经验关联少，说明适用边界清晰）

4. 晋升来源 Experience 的 `referenced_count ≥ 3`（被多次引用验证，不是偶然晋升）

不满足任一条件 → 保持 `pending`，等待人工审核。

`reviewed_by` 设为 `"system_auto"`，`reviewed_at` 写当前时间。
