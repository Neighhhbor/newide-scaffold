## 修正方案：Agent 自驱循环入口 `executeTask`

### 核心改动

**`Agent` 新增 `executeTask()`** — Agent 自驱执行入口，区别于 `runOnce`：

```
Agent.executeTask(task)
  ├─ Tool-calling → assignTask → [runLoopTick × N] → writeToBuffer → done
  │                     ↑ Agent 自己的循环，不含提取/晋升
  └─ Pipeline 降级 → runTaskMemoryCycle (向后兼容)
```

**`AgentManager.submitTask()`** — 去掉异步派单，始终调 `winner.executeTask()`：

```typescript
const cycle = await winner.executeTask(request);
return { winner_role_id, scores, cycle, status: 'completed' };
```

### 改动清单

| 文件                                         | 改动                                                                                                                             |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `src/memory/runtime/agent.ts`                | 新增 `executeTask()`；`runOnceWithTools` 不变（向后兼容）                                                                        |
| `src/memory/runtime/agent-manager.ts`        | `submitTask` 去掉异步派单分支，调 `executeTask`；`SubmitTaskResult.cycle` 恢复为必选；`toMemoryTaskProjection` 去掉 pending 分支 |
| `src/memory/test/agent-tool-calling.test.ts` | AgentManager 测试恢复为 `result.cycle.buffer_snapshot.task_id`                                                                   |
| `src/memory/test/agent-run-loop.test.ts`     | 更新 submitTask 异步派单测试为同步验证                                                                                           |

### 向后兼容

| 调用方式                                     | 行为                                 | 变化                              |
| -------------------------------------------- | ------------------------------------ | --------------------------------- |
| `agent.runOnce(task)`                        | 不变（Tool-calling/Pipeline 均可）   | 无                                |
| `agent.executeTask(task)`                    | Tool-calling 自驱循环；Pipeline 降级 | 新增                              |
| `manager.submitTask(task)`                   | 调 executeTask，始终返回 cycle       | 之前 tool-calling 返回 dispatched |
| `manager.tickAll()`                          | 底层逐 tick 驱动                     | 保留                              |
| `agent.assignTask()` + `agent.runLoopTick()` | 逐 tick 控制                         | 保留                              |
