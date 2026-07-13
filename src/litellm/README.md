# LiteLLM Client

In-process LLM client powered by [Vercel AI SDK](https://sdk.vercel.ai).  
No external proxy. Pure TypeScript.

## File Structure

```
src/litellm/
├── contract.ts                     # Public interfaces
├── client.ts                       # Core orchestration via AI SDK
├── index.ts                        # Barrel export
│
├── config-loader.ts                # YAML config loader (js-yaml + profile resolver)
├── config/                         # Configuration directory
│   ├── defaults.yaml               # Global defaults
│   ├── profiles.yaml               # Reusable model profiles
│   ├── classify-intent.yaml        # Per-task config (one file per method)
│   └── ...                         # Add your method's config here
│
├── model-pool.ts                   # Task → (provider, model) resolution
├── model-router.ts                 # Selection strategies + provider detection
├── model-config.ts                 # Per-task config storage
│
├── tools/                          # Tool subsystem
│   ├── index.ts
│   ├── tool-interface.ts           # BaseTool + parameter helpers
│   ├── tool-registry.ts            # Register / lookup / execute
│   └── mock-tool.ts                # Template
│
└── methods/                        # Method subsystem
    ├── index.ts
    ├── method-interface.ts         # BaseMethod (tools + structured output built in)
    ├── method-registry.ts          # Register / lookup by name
    ├── method-router.ts            # Call methods with MethodContext
    └── mock-method.ts              # Template
```

### Responsibilities

| Layer                                          | Role                                                                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `contract.ts`                                  | Public interfaces — `CompletionRequest`, `MethodHandler`, `Tool`, `ModelProfile`, …                                |
| `client.ts`                                    | Orchestrates model selection + LLM calls. Exposes `complete()`, `stream()`, `structured()`, `completeWithTools()`. |
| `model-pool` / `model-router` / `model-config` | Task → model resolution with pluggable strategies (`order`, `cheapest`, `fastest`, `auto`, `explicit`).            |
| `config-loader.ts`                             | Parses YAML into typed configs. Resolves `profile:` references. Supports single-file and multi-file loading.       |
| `tools/`                                       | LLM-callable functions. Each tool is a self-contained class with a JSON Schema and an `execute()` method.          |
| `methods/`                                     | Named task workflows. Each method encapsulates prompt assembly + LLM orchestration.                                |

---

## API

The client exposes four core methods. All are available on `LiteLLMClient`
and inside any method's `execute()` via the `MethodContext`.

### Direct Completion

```ts
const resp = await client.complete({
  task: 'classify-intent',
  messages: [
    { role: 'system', content: 'Classify user intent.' },
    { role: 'user', content: 'Hello' },
  ],
});
// → { content: string, usage: TokenUsage, finishReason: string, … }
```

### Tool Calling (auto-loop)

```ts
const resp = await client.completeWithTools(
  { task: 'memory-query', messages },
  { get_weather: async (args) => `Sunny in ${args.city}` },
  5, // max rounds
);
```

### Streaming

```ts
for await (const chunk of client.stream({ task: 'summarize-chat', messages })) {
  console.log(chunk.delta.content);
}
```

### Structured Output

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

### Method Routing

```ts
client.registerMethod(new MyMethod());
const result = await client.methods.call('my-method', { input: '…' });
```

---

## Development Workflow

### Add a Tool

1. Copy `tools/mock-tool.ts` → `tools/my-tool.ts`
2. Set `name`, `description`, `parameters`
3. Implement `execute(args)`
4. Register: `client.tools.register(new MyTool())`

Or register ad-hoc without a class:

```ts
client.tools.registerAdHoc('my_tool', 'description', paramsSchema, handler);
```

### Add a Method

1. Copy `methods/mock-method.ts` → `methods/my-method.ts`
2. Set `name`, `description`, `task`
3. Declare tools as instances: `readonly tools = [new WeatherTool()]` (auto-extracts schemas + handlers)
4. Optionally set `defaultProfile` (e.g. `'cheap'`) to declare model preference
5. Implement `execute(context, params)`
6. Create `config/<task>.yaml` matching the method's `task` name
7. Register: `client.registerMethod(new MyMethod())` — validates task name against loaded config

In `execute()`, use the `context` object directly:

- `context.complete(request)` — basic completion
- `context.completeWithTools(request, handlers, maxRounds)` — tool-calling loop
- `context.structured<T>(request)` — typed JSON output
- `context.stream(request)` — streaming

Combine freely — see `mock-method.ts` for four patterns including a combined tools + structured output example.

### Configure models for a Method

Create a new `.yaml` file in the `config/` directory:

```yaml
# config/my-method.yaml
tasks:
  my-method:
    profile: cheap
    timeoutMs: 15000
```

No other files need to be edited — profiles from `profiles.yaml` are automatically
available to all files in the directory.

If the referenced profile does not exist, an error is thrown at load time.

### Add a Provider

```ts
// 1. pnpm add @ai-sdk/google
// 2. Register (SDK lazy-loaded on first use):
import { google } from '@ai-sdk/google';
client.registerProvider('google', (modelId) => google(modelId));
```

```yaml
# 3. Use in a profile:
profiles:
  cheap:
    models:
      - provider: google
        model: gemini-2.0-flash
```

Built-in providers (openai, anthropic) are lazy-loaded via dynamic `import()`.
Registration is instance-level — no cross-client pollution.

---

## Configuration

Configuration lives in a directory of `.yaml` files. All files are loaded and merged —
profiles by name, tasks by task name.

```
config/
├── defaults.yaml       # Global defaults
├── profiles.yaml       # Reusable model profiles
├── <task>.yaml         # One per method
└── my-method.yaml      # Add yours here
```

```ts
client.loadConfig('./config/');
// Or use the bundled config:
client.loadConfig();
```

Each developer can add their method's config in a separate file — no merge conflicts.

### Profiles

Reusable model groups — define once, reference by name:

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
    profile: cheap # inherits models + strategy
    maxTokens: 500 # override specific fields
```

Task-level fields override profile-level fields. See `config/` for working examples.

### Strategies

| Strategy                                | Behavior                                              |
| --------------------------------------- | ----------------------------------------------------- |
| `order`                                 | Try lowest `order` first, fall back to next           |
| `auto`                                  | Filter by available API keys, then by `order`         |
| `cheapest`                              | Pick the model with lowest `costPer1kTokens`          |
| `fastest`                               | Heuristic: flash-lite > mini > flash > haiku > sonnet |
| `{ type: 'explicit', model: 'gpt-4o' }` | Always use this exact model                           |

### Environment Variables

| Variable            | Used by             |
| ------------------- | ------------------- |
| `OPENAI_API_KEY`    | `@ai-sdk/openai`    |
| `ANTHROPIC_API_KEY` | `@ai-sdk/anthropic` |

Provider SDKs read these automatically.

---

## Error Handling

### Configuration Errors

| Error                                         | When                               | Action                                            |
| --------------------------------------------- | ---------------------------------- | ------------------------------------------------- |
| `No model configuration for task "xxx"`       | Task not in config                 | Add task to YAML or call `loadConfig()` first     |
| `Unknown provider "xxx"`                      | Provider not registered            | `client.registerProvider(name, factory)`          |
| `Task "xxx" references unknown profile "yyy"` | Profile name typo or missing       | Check spelling; define the profile in `profiles:` |
| `NoModelAvailableError`                       | All models disabled or no API keys | Check env vars; enable a model or add a fallback  |

### AI SDK Errors

All extend `AISDKError` (exported from `ai`).

| Error class                | Typical cause                                                     |
| -------------------------- | ----------------------------------------------------------------- |
| `APICallError`             | Timeout, rate limit (429), auth failure (401), server error (5xx) |
| `InvalidResponseDataError` | Provider returned malformed data                                  |
| `NoContentGeneratedError`  | Model produced no output (safety filter, etc.)                    |
| `InvalidPromptError`       | Prompt rejected by provider's content policy                      |
| `LoadAPIKeyError`          | Missing API key env var                                           |

```ts
import { AISDKError, APICallError } from 'ai';

try {
  const resp = await client.complete({ task: 'my-task', messages });
} catch (err) {
  if (APICallError.is(err)) {
    if (err.statusCode === 429) await sleep(retryAfterMs);
    else if (err.statusCode >= 500) {
      /* retry with fallback */
    }
  } else if (AISDKError.is(err)) {
    /* log + optionally retry */
  } else {
    throw err;
  }
}
```

### Routing Errors

| Error                    | When                       | Action                                  |
| ------------------------ | -------------------------- | --------------------------------------- |
| `Method "xxx" not found` | Unregistered method called | `client.registerMethod(...)` then retry |

### Tool Errors

| Error                              | When                                 | Action                                                                               |
| ---------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------ |
| `completeWithTools requires tools` | No tools registered, `maxRounds > 1` | Register a tool or set `maxRounds: 1`                                                |
| Tool `execute()` throws            | Handler error during tool loop       | Error returned as tool result; LLM may self-correct; if not, throws after `maxSteps` |

---

## Quick Start

```ts
import { LiteLLMClient } from './litellm';

const client = new LiteLLMClient();
client.loadConfig(); // loads the bundled config/ directory

const resp = await client.complete({
  task: 'classify-intent',
  messages: [{ role: 'user', content: 'Hello' }],
});
console.log(resp.content);
```
