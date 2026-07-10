/**
 * createDriverAdapterDeps — 接入真实 Driver 的 AgentRunDeps 工厂
 *
 * 这是 defaultMvpAgentRunDeps 和 createDefaultLlmAgentRunDeps 的生产级对应物：
 * 将 invokeDriver 从 mock 替换为 DriverAdapter 适配的真实外部 Driver。
 *
 * ## 与现有 deps 工厂的对比
 *
 * | 工厂函数                        | invokeDriver      | extractor/promote    |
 * |--------------------------------|-------------------|----------------------|
 * | defaultMvpAgentRunDeps         | invokeMockDriver  | 启发式               |
 * | createDefaultLlmAgentRunDeps   | invokeMockDriver  | LLM                  |
 * | createDriverAdapterDeps（本文件）| DriverAdapter     | 可选：启发式或 LLM    |
 *
 * ## 三档配置
 *
 * ### 档位 1: 仅替换 Driver（最简）
 *
 * ```typescript
 * const deps = createDriverAdapterDeps({ driverCommand: 'gemini' });
 * // => 真实 Driver + 启发式 extractor/promote
 * ```
 *
 * ### 档位 2: Driver + LLM 提取
 *
 * ```typescript
 * const deps = createDriverAdapterDeps({
 *   driverCommand: 'gemini',
 *   llmOptions: { apiKey: process.env.DEEPSEEK_API_KEY },
 * });
 * // => 真实 Driver + LLM 提取经验/晋升技能
 * ```
 *
 * ### 档位 3: Driver + LLM 提取 + LLM 结果映射
 *
 * ```typescript
 * const deps = createDriverAdapterDeps({
 *   driverCommand: 'gemini',
 *   llmOptions: { apiKey: process.env.DEEPSEEK_API_KEY },
 *   useLlmResultMapping: true,
 * });
 * // => 真实 Driver + LLM 提取 + LLM 辅助的 DriverRunResult→DriverReturn 映射
 * ```
 *
 * ## 注入方式
 *
 * ```typescript
 * import { AgentManager, InMemoryRepository, InMemoryBufferRepository } from '../memory';
 * import { createDriverAdapterDeps } from '../memory/mvp/default-driver-adapter-deps';
 *
 * const repo = new InMemoryRepository();
 * const bufRepo = new InMemoryBufferRepository();
 * const deps = createDriverAdapterDeps({
 *   driverCommand: 'gemini', driverArgs: ['acp'],
 * });
 * const manager = AgentManager.create(repo, bufRepo, { deps });
 * ```
 */
import type { AgentRunDeps } from '../runtime/agent-run-deps';
import type { DeepSeekLlmClientOptions } from '../adapters/deepseek-llm-client';
import type { DriverResultMapper } from '../adapters/driver-adapter';

import {
  ExternalDriverRuntime,
  CommandDriverTransport,
  type DriverRuntimeHandle,
} from '../../driver';
import { createDriverInvoker } from '../adapters/driver-adapter';
import { repositoryRetrieveMemoryForTask } from '../adapters/repository-memory-retrieval';
import { NullContextCleaner } from '../adapters/null-context-cleaner';
import { RuleBasedExperienceExtractor } from '../adapters/rule-based-experience-extractor';
import { ruleBasedSkillPromotion } from '../services/skill-promotion';
import { mockPlanTaskInstruction } from './adapters/mock-task-instruction-planner';

import { DeepSeekLlmClient } from '../adapters/deepseek-llm-client';
import { LlmExperienceExtractor } from '../adapters/llm-experience-extractor';
import { LlmTaskInstructionPlanner } from '../adapters/llm-task-instruction-planner';
import { LlmContextCleaner } from '../adapters/context-cleaner';
import { LlmSkillPromotion } from '../adapters/llm-skill-promotion';
import { LlmDriverResultMapper } from '../adapters/llm-driver-result-mapper';

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface DriverAdapterDepsOptions {
  /** 外部 Driver 的命令（如 'gemini', 'claude', 'node'） */
  driverCommand: string;
  /** 命令参数（如 ['acp'], ['--experimental']） */
  driverArgs?: string[];
  /** Driver 标识符，缺省为 'acp-agent' */
  driverId?: string;
  /** 超时时间（毫秒），缺省 120_000 */
  driverTimeoutMs?: number;
  /** 工作目录 */
  driverCwd?: string;
  /** 环境变量 */
  driverEnv?: NodeJS.ProcessEnv;
  /** 需要清除的环境变量名 */
  driverUnsetEnv?: string[];

  /** DeepSeek LLM 客户端配置（用于 extractor/promote/planner/cleaner）。
   *  不传则退化为启发式实现（与 defaultMvpAgentRunDeps 对齐） */
  llmOptions?: DeepSeekLlmClientOptions;
  /** 是否用 LLM 做 DriverRunResult → DriverReturn 映射（需要 llmOptions）。
   *  缺省为 false，使用启发式映射器 mapRunResultToDriverReturn。
   *  设为 true 时精度更高但会增加一次 LLM 调用。 */
  useLlmResultMapping?: boolean;
  /** 自定义 Driver 结果映射器（优先级高于 useLlmResultMapping） */
  customResultMapper?: DriverResultMapper;
  /** 自定义 DriverRuntimeHandle（优先级高于 driverCommand + driverArgs 组合） */
  customDriverRuntime?: DriverRuntimeHandle;
}

// ═══════════════════════════════════════════════════════════════
// 工厂函数
// ═══════════════════════════════════════════════════════════════

/**
 * 创建接入**真实 Driver** 的 AgentRunDeps。
 *
 * 骨架与 defaultMvpAgentRunDeps 一致，唯一的区别在于 invokeDriver
 * 由 DriverAdapter 驱动，而非 mock。
 *
 * 典型流程：
 * driverCommand/driverArgs → CommandDriverTransport → ExternalDriverRuntime
 *   → DriverAdapter → invokeDriver 函数
 *
 * 如果传入了 customDriverRuntime，优先使用——跳过 transport 构造。
 * 如果传入了 customResultMapper，优先使用——跳过启发式/LLM 映射二选一。
 *
 * @param options - Driver 连接配置与可选的 LLM 提取配置
 * @returns 可直接注入 AgentManager/Agent 的 AgentRunDeps
 */
export function createDriverAdapterDeps(options: DriverAdapterDepsOptions): AgentRunDeps {
  // ── 1. 构造 Driver 运行时 ──
  const driverRuntime = options.customDriverRuntime ?? buildDriverRuntime(options);

  // ── 2. 决定结果映射策略 ──
  const mapResult = resolveResultMapper(options);

  // ── 3. 创建 invokeDriver 函数 ──
  const invokeDriver = createDriverInvoker({
    driverRuntime,
    ...(mapResult ? { mapResult } : {}),
  });

  // ── 4. 基础 deps（启发式，与 defaultMvpAgentRunDeps 对齐） ──
  const deps: AgentRunDeps = {
    queryMemory: repositoryRetrieveMemoryForTask,
    planTaskInstruction: mockPlanTaskInstruction,
    invokeDriver,
    extractor: new RuleBasedExperienceExtractor(),
    promote: ruleBasedSkillPromotion,
    contextCleaner: new NullContextCleaner(),
  };

  // ── 5. 如果提供了 llmOptions，升级为 LLM 实现 ──
  if (options.llmOptions) {
    const llm = new DeepSeekLlmClient(options.llmOptions);
    const planner = new LlmTaskInstructionPlanner(llm);

    deps.planTaskInstruction = (task) => planner.plan(task);
    deps.extractor = new LlmExperienceExtractor(llm);
    deps.promote = new LlmSkillPromotion(llm).promote;
    deps.contextCleaner = new LlmContextCleaner(llm);
  }

  return deps;
}

// ═══════════════════════════════════════════════════════════════
// 内部 helper
// ═══════════════════════════════════════════════════════════════

function buildDriverRuntime(options: DriverAdapterDepsOptions): DriverRuntimeHandle {
  const transport = new CommandDriverTransport({
    command: options.driverCommand,
    args: options.driverArgs ?? [],
    timeoutMs: options.driverTimeoutMs ?? 120_000,
    cwd: options.driverCwd,
    env: options.driverEnv,
    unsetEnv: options.driverUnsetEnv,
  });

  return new ExternalDriverRuntime({
    driver_id: options.driverId ?? 'acp-agent',
    transport,
  });
}

function resolveResultMapper(options: DriverAdapterDepsOptions): DriverResultMapper | undefined {
  // 1. 自定义 mapper 优先级最高
  if (options.customResultMapper) {
    return options.customResultMapper;
  }

  // 2. LLM 映射器（需要 llmOptions）
  if (options.useLlmResultMapping) {
    if (!options.llmOptions) {
      throw new Error(
        'useLlmResultMapping requires llmOptions. ' +
          'Either provide llmOptions or disable useLlmResultMapping.',
      );
    }
    const llm = new DeepSeekLlmClient(options.llmOptions);
    return new LlmDriverResultMapper(llm).map;
  }

  // 3. 不传 → undefined，DriverAdapter 会使用默认启发式映射器
  return undefined;
}
