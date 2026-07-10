# LiteLLM Client

基于 [Vercel AI SDK](https://sdk.vercel.ai) 的进程内 LLM 客户端。  
无外部代理。纯 TypeScript。

## 文件结构

```
src/litellm/
├── contract.ts                     # 公共接口定义
├── client.ts                       # 核心编排（通过 AI SDK 调用 LLM）
├── index.ts                        # 统一导出
│
├── config-loader.ts                # YAML 配置加载（js-yaml + profile 解析）
├── config/                         # 配置目录
│   ├── defaults.yaml               # 全局默认参数
│   ├── profiles.yaml               # 可复用的模型 profiles
│   ├── classify-intent.yaml        # 每个 method 一个配置文件
│   └── ...                         # 在这里添加你的 method 配置
│
├── model-pool.ts                   # Task → (provider, model) 解析
├── model-router.ts                 # 选择策略 + provider 检测
├── model-config.ts                 # 按任务存储配置
│
├── tools/                          # Tool 子系统
│   ├── index.ts
│   ├── tool-interface.ts           # BaseTool + 参数辅助函数
│   ├── tool-registry.ts            # 注册 / 查找 / 执行
│   └── mock-tool.ts                # 模板
│
└── methods/                        # Method 子系统
    ├── index.ts
    ├── method-interface.ts         # BaseMethod（内置 tools + structured output）
    ├── method-registry.ts          # 按名称注册 / 查找
    ├── method-router.ts            # 调用方法并注入 MethodContext
    └── mock-method.ts              # 模板
```

### 各层职责

| 层                                             | 职责                                                                                          |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `contract.ts`                                  | 公共接口——`CompletionRequest`、`MethodHandler`、`Tool`、`ModelProfile` 等                     |
| `client.ts`                                    | 编排模型选择 + LLM 调用。暴露 `complete()`、`stream()`、`structured()`、`completeWithTools()` |
| `model-pool` / `model-router` / `model-config` | Task → 模型解析，支持可插拔策略（`order`、`cheapest`、`fastest`、`auto`、`explicit`）         |
| `config-loader.ts`                             | 解析 YAML 为类型化配置。解析 `profile:` 引用。支持单文件和多文件加载                          |
| `tools/`                                       | LLM 可调用的函数。每个 tool 是自包含的类：一个 JSON Schema + 一个 `execute()` 方法            |
| `methods/`                                     | 命名任务工作流。每个 method 封装 prompt 组装 + LLM 编排                                       |

---

## 调用接口

客户端提供四种核心方法。可在 `LiteLLMClient` 上直接调用，
也可在任意 method 的 `execute()` 中通过 `MethodContext` 调用。

### 普通补全

```ts
const resp = await client.complete({
  task: 'classify-intent',
  messages: [
    { role: 'system', content: '判断用户意图。' },
    { role: 'user', content: '你好' },
  ],
});
// → { content: string, usage: TokenUsage, finishReason: string, … }
```

### 工具调用（自动循环）

```ts
const resp = await client.completeWithTools(
  { task: 'memory-query', messages },
  { get_weather: async (args) => `${args.city}：晴天，22°C` },
  5, // 最大轮次
);
```

### 流式输出

```ts
for await (const chunk of client.stream({ task: 'summarize-chat', messages })) {
  console.log(chunk.delta.content);
}
```

### 结构化输出

```ts
const data = await client.structured<{ name: string; age: number }>({
  task: 'extract-entities',
  messages,
  responseFormat: {
    name: 'person',
    schema: { type: 'object', properties: { name: { type: 'string' }, age: { type: 'number' } } },
    strict: true,
  },
});
// → { name: 'Alice', age: 30 }
```

### 方法路由

```ts
client.registerMethod(new MyMethod());
const result = await client.methods.call('my-method', { input: '…' });
```

---

## 开发流程

### 新增 Tool

1. 复制 `tools/mock-tool.ts` → `tools/my-tool.ts`
2. 设置 `name`、`description`、`parameters`
3. 实现 `execute(args)`
4. 注册：`client.tools.register(new MyTool())`

无需 class 的即兴注册：

```ts
client.tools.registerAdHoc('my_tool', '描述', paramsSchema, handler);
```

### 新增 Method

1. 复制 `methods/mock-method.ts` → `methods/my-method.ts`
2. 设置 `name`、`description`、`task`
3. 将工具声明为实例：`readonly tools = [new WeatherTool()]`（schema + handler 自动提取）
4. 可选：设置 `defaultProfile`（如 `'cheap'`）声明模型偏好
5. 实现 `execute(context, params)`
6. 创建 `config/<task>.yaml` 匹配 method 的 `task` 名称
7. 注册：`client.registerMethod(new MyMethod())`——会校验 task 名与已加载配置的一致性

三种模式（详见 `mock-method.ts`），均继承同一个 `BaseMethod`：

- **简单模式**——调用 `context.complete()`
- **工具调用模式**——声明 `readonly tools = [...]`，调用 `this.executeWithTools()`
- **结构化输出模式**——调用 `this.executeStructured<T>()`
- 可任意组合——一个 method 可以同时使用 tools 和 structured output

### 为 Method 配置模型

在 `config/` 目录下新建一个 `.yaml` 文件：

```yaml
# config/my-method.yaml
tasks:
  my-method:
    profile: cheap
    timeoutMs: 15000
```

无需编辑其他文件——`profiles.yaml` 中定义的 profiles 自动对所有文件可见。

如果引用的 profile 不存在，加载时立即报错。

### 新增 Provider

```ts
// 1. pnpm add @ai-sdk/google
// 2. 注册（SDK 在首次使用时懒加载）：
import { google } from '@ai-sdk/google';
client.registerProvider('google', (modelId) => google(modelId));
```

```yaml
# 3. 在 profile 中使用：
profiles:
  cheap:
    models:
      - provider: google
        model: gemini-2.0-flash
```

内置 provider（openai、anthropic）通过动态 `import()` 懒加载。
注册是实例级的——无跨客户端污染。

---

## 配置说明

配置存放在一个 `.yaml` 文件目录中。所有文件被加载并合并——
profiles 按名称合并，tasks 按任务名称合并。

```
config/
├── defaults.yaml       # 全局默认参数
├── profiles.yaml       # 可复用的模型 profiles
├── <task>.yaml         # 每个 method 一个文件
└── my-method.yaml      # 在这里添加你的配置
```

```ts
client.loadConfig('./config/');
// 或使用内置配置：
client.loadConfig();
```

每个开发者可以在目录中创建独立文件——无合并冲突。

### Profiles

可复用的模型组——定义一次，按名称引用：

```yaml
profiles:
  cheap:
    strategy: cheapest
    models:
      - provider: openai, model: gpt-4o-mini, costPer1kTokens: 0.00015, order: 1
      - provider: anthropic, model: claude-3-5-haiku-latest, costPer1kTokens: 0.00025, order: 2
```

```yaml
tasks:
  classify-intent:
    profile: cheap # 继承 models + strategy
    maxTokens: 500 # 覆盖特定字段
```

Task 级字段覆盖 profile 级字段。可运行示例见 `config/` 目录。

### 选择策略

| 策略                                    | 行为                                               |
| --------------------------------------- | -------------------------------------------------- |
| `order`                                 | 优先选 `order` 最小的模型，失败则 fallback         |
| `auto`                                  | 过滤出有 API key 的 provider，再按 `order` 选择    |
| `cheapest`                              | 选 `costPer1kTokens` 最低的模型                    |
| `fastest`                               | 启发式：flash-lite > mini > flash > haiku > sonnet |
| `{ type: 'explicit', model: 'gpt-4o' }` | 始终使用指定模型                                   |

### 环境变量

| 变量                | 使用者              |
| ------------------- | ------------------- |
| `OPENAI_API_KEY`    | `@ai-sdk/openai`    |
| `ANTHROPIC_API_KEY` | `@ai-sdk/anthropic` |

Provider SDK 自动读取环境变量。

---

## 错误处理

### 配置错误

| 错误                                          | 触发条件                     | 处理                                        |
| --------------------------------------------- | ---------------------------- | ------------------------------------------- |
| `No model configuration for task "xxx"`       | 任务未在配置中定义           | 在 YAML 中添加任务，或先调用 `loadConfig()` |
| `Unknown provider "xxx"`                      | Provider 未注册              | `client.registerProvider(name, factory)`    |
| `Task "xxx" references unknown profile "yyy"` | Profile 名称拼写错误或不存在 | 检查拼写；在 `profiles:` 中定义该 profile   |
| `NoModelAvailableError`                       | 所有模型被禁用或无 API key   | 检查环境变量；启用模型或添加备用 provider   |

### AI SDK 错误

均继承自 `AISDKError`（从 `ai` 导出）。

| 错误类                     | 典型原因                                           |
| -------------------------- | -------------------------------------------------- |
| `APICallError`             | 超时、限流 (429)、认证失败 (401)、服务端错误 (5xx) |
| `InvalidResponseDataError` | Provider 返回格式异常的数据                        |
| `NoContentGeneratedError`  | 模型未产生输出（安全过滤器等）                     |
| `InvalidPromptError`       | 提示词被 provider 内容策略拒绝                     |
| `LoadAPIKeyError`          | 缺少 API key 环境变量                              |

```ts
import { AISDKError, APICallError } from 'ai';

try {
  const resp = await client.complete({ task: 'my-task', messages });
} catch (err) {
  if (APICallError.is(err)) {
    if (err.statusCode === 429) await sleep(retryAfterMs);
    else if (err.statusCode >= 500) {
      /* 重试或切换备用模型 */
    }
  } else if (AISDKError.is(err)) {
    /* 记录日志，视情况重试 */
  } else {
    throw err;
  }
}
```

### 路由错误

| 错误                     | 触发条件           | 处理                                |
| ------------------------ | ------------------ | ----------------------------------- |
| `Method "xxx" not found` | 调用了未注册的方法 | `client.registerMethod(...)` 后重试 |

### Tool 错误

| 错误                               | 触发条件                     | 处理                                                                            |
| ---------------------------------- | ---------------------------- | ------------------------------------------------------------------------------- |
| `completeWithTools requires tools` | 未注册工具且 `maxRounds > 1` | 注册工具或将 `maxRounds` 设为 1                                                 |
| Tool `execute()` 抛出异常          | 工具循环中 handler 出错      | 错误以 tool result 形式返回；LLM 可自行纠正；若无法恢复，耗尽 `maxSteps` 后抛出 |

---

## 快速开始

```ts
import { LiteLLMClient } from './litellm';

const client = new LiteLLMClient();
client.loadConfig(); // 加载内置的 config/ 目录

const resp = await client.complete({
  task: 'classify-intent',
  messages: [{ role: 'user', content: '你好' }],
});
console.log(resp.content);
```
