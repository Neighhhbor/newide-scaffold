## 计划：合并 direction-B + 新增 createDriverTool 桥接

### 目标

把 direction-B 的 DriverAdapter 以 Tool 形式接入 Tool-calling 模式的 InvokeDriverTool，让 LLM 可以通过 `invoke_driver` 工具调用外部 Driver。

### Step 1：合并 direction-B

当前分支 `feat/integration-test-agent-loop` 有未提交的改动（competition claim），先提交，再合并。

需要手动解决冲突的文件：

| 文件                                  | 冲突原因                                                         | 解决策略                                                                                                            |
| ------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `src/memory/runtime/agent-manager.ts` | direction-B 有旧 submitTask；我们有 dispatchTask                 | 保留我们的 dispatchTask + collectCompetitionClaims + DispatchTaskResult，接受 direction-B 的 tickAll/tools 新增功能 |
| `src/memory/index.ts`                 | 两边都在相近区域加 exports                                       | 合并两边 export，确保不遗漏                                                                                         |
| `src/memory/runtime/agent.ts`         | direction-B 是 tool-calling 基础版；我们在此基础上加了 evaluator | 接受 direction-B 的版本后重新叠加 evaluator/createCompetitionClaim                                                  |

### Step 2：新增 `createDriverTool(adapter)`

在 `src/memory/adapters/driver-adapter.ts` 尾部新增导出函数：

```typescript
export function createDriverTool(adapter: DriverAdapter): InvokeDriverTool {
  const handler: DriverHandler = async (task) => {
    return adapter.invoke({
      task_id: createId('task'),
      call_id: createId('call'),
      source_driver: 'acp-driver',
      driver_context: {
        task_instruction: task.instruction,
        skills: [],
        experiences: [],
      },
    });
  };
  return new InvokeDriverTool(handler);
}
```

这个函数做一层很薄的转换：

```
DriverTask.instruction         → DriverInvokeInput.driver_context.task_instruction
DriverTask.context?.skills[]   → DriverInvokeInput.driver_context.skills[]（序列化为 SkillRecord）
DriverTask.context?.experiences[] → DriverInvokeInput.driver_context.experiences[]（序列化为 ExperienceRecord）
```

### Step 3：更新 `create-agent-runtime.ts`

让生产工厂同时支持 Pipeline 和 Tool-calling 两种接入方式：

```typescript
export interface AgentRuntimeConfig {
  // ... 现有字段 ...
  tools?: {
    driver?: DriverHandler; // 已有：纯 Tool 接入
    driverAdapter?: DriverAdapterOptions; // 新增：通过 DriverAdapter 接入
    additional?: Tool[];
  };
}
```

当提供 `driverAdapter` 时，自动创建 `DriverAdapter` 并同时：

1. 注册为 `AgentRunDeps.invokeDriver`（给 Pipeline 用）
2. 通过 `createDriverTool()` 包装为 `InvokeDriverTool` 注册到 tools 列表（给 Tool-calling 用）

### Step 4：导出

在 `src/memory/index.ts` 新增 `createDriverTool` 导出。

### Step 5：测试验证

合并后运行全部 memory 测试确保 183 个用例不变。

---

### 使用效果（合并后）

```typescript
import { createAgentRuntime } from '../memory';

const manager = createAgentRuntime({
  llm: deepseekClient,
  tools: {
    driverAdapter: {
      driverRuntime: myExternalDriver,
    },
  },
});
```

LLM 在 Tool-calling 模式下调用 `invoke_driver` 时，会自动走 `DriverAdapter.invoke()` → `serializeDriverContext` → `sendPrompt` → `mapRunResultToDriverReturn`。
