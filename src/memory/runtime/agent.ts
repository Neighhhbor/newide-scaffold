/**
 * Agent 运行时（员工）
 *
 * 持有 AgentMemoryScope 与可注入的 AgentRunDeps；负责 bid、runOnce 状态机。
 *
 * ## 两种执行模式
 *
 * 1. **Pipeline 模式**（默认）— 硬编码的「查记忆 → Driver → buffer → 提取 → 晋升」流程
 *    通过 AgentRunDeps 注入各环节实现，由 runTaskMemoryCycle 编排。
 *
 * 2. **Tool-calling 模式**（传入 toolConfig 时启用）— 顶层 Agent 的 LLM 自主 tool-calling
 *    拥有 query_memory/invoke_driver 等工具，自主决策执行流程。
 *    Driver 作为插槽由外部注入，memory 模块不关心其内部实现。
 *
 * ## 两种执行路径
 *
 * - `runOnce(task)` — 同步一次性执行（Pipeline / Tool-calling 均可），向后兼容
 * - `assignTask(task)` + 多次 `runLoopTick()` — 异步逐 tick 执行（仅 Tool-calling 模式）
 *
 * ## 向后兼容
 *
 * - `new Agent(memory)` 或 `new Agent(memory, deps)` → Pipeline 模式
 * - `new Agent(memory, deps, { llm, tools })` → Tool-calling 模式
 * - `runOnce()` 在两种模式下均可用
 * - 所有现有代码和测试不受影响
 */
import type { AgentHandle } from '../schemas';
import type { AgentMemoryScope } from '../ports/agent-memory-scope';
import type { AgentLoopState, AgentLoopTickResult, AgentTaskRequest } from '../agent-types';
import type { MemoryCycleResult } from '../types';
import type { AgentRunDeps } from './agent-run-deps';
import { runTaskMemoryCycle } from '../services/memory-cycle';
import { defaultMvpAgentRunDeps } from '../mvp/default-agent-run-deps';
import { ToolRegistry, type Tool, type ToolCallMessage, type ToolCallingClient } from './tool';
import { createId, nowTimestamp } from '../../core';
import { writePendingBuffer } from '../services/buffer-writer';
import { buildAgentSystemPrompt } from '../prompts/agent-system-prompt';
import type { DriverReturn } from '../schemas';

// ──────────────────────────────────────────────
// Tool-calling 配置
// ──────────────────────────────────────────────

/**
 * Agent 的 tool-calling 模式配置。
 * 提供此配置时，Agent 将使用 LLM tool-calling 替代固定 pipeline。
 */
export interface AgentToolConfig {
  /** 顶层 Agent 的 LLM（需支持 tool-calling） */
  llm: ToolCallingClient;
  /** 注册的工具列表（如 QueryMemoryTool、InvokeDriverTool 等） */
  tools: Tool[];
  /** 顶层 Agent 的系统提示词 */
  systemPrompt?: string;
  /** 单次任务最大 tool-calling 轮次（防死循环，默认 20） */
  maxToolCalls?: number;
}

// ──────────────────────────────────────────────
// Agent 类
// ──────────────────────────────────────────────

export class Agent {
  private state: AgentLoopState = 'idle';
  private readonly toolConfig: AgentToolConfig | undefined;
  private readonly toolRegistry: ToolRegistry | undefined;

  // ── 持久循环状态（跨 tick 存活） ──
  /** 当前处理的 task；null 表示空闲 */
  private currentTask: AgentTaskRequest | null = null;
  /** 跨 tick 累积的 tool-calling 对话消息 */
  private loopMessages: ToolCallMessage[] | null = null;
  /** 最后一次 invoke_driver 的返回（写入 buffer 时需要） */
  private lastDriverReturn: DriverReturn | undefined;
  /** 已执行轮次（防死循环） */
  private loopRound: number = 0;
  /** 任务完成后的 cycle 结果，供 runOnce 包装使用 */
  private lastCycleResult: MemoryCycleResult | null = null;

  constructor(
    private readonly memory: AgentMemoryScope,
    private readonly deps: AgentRunDeps = defaultMvpAgentRunDeps,
    toolConfig?: AgentToolConfig,
  ) {
    this.toolConfig = toolConfig;
    if (toolConfig) {
      this.toolRegistry = new ToolRegistry(toolConfig.tools);
    }
  }

  get role_id(): string {
    return this.memory.role_id;
  }

  getState(): AgentLoopState {
    return this.state;
  }

  getHandle(): Promise<AgentHandle> {
    return this.memory.getAgent();
  }

  /** 是否有待处理的任务 */
  hasPendingTask(): boolean {
    return this.currentTask !== null;
  }

  /**
   * 目标态持久 run loop 入口。
   *
   * 当前不会启动后台 worker 或任务队列，只把 Agent 放入 sleeping 状态，等待
   * AgentManager.submitTask 通过 assignTask 显式派发任务。
   */
  startLoop(): void {
    if (this.state !== 'stopped') {
      this.state = 'sleeping';
    }
  }

  wake(): void {
    if (this.state === 'sleeping') {
      this.state = 'idle';
    }
  }

  stop(): void {
    this.state = 'stopped';
    this.clearLoopState();
  }

  async bid(_task: AgentTaskRequest): Promise<number> {
    return 0.5;
  }

  // ────────────────────────────────────────────
  // 持久循环（逐 tick）
  // ────────────────────────────────────────────

  /**
   * 持久 run loop 的单步执行。
   *
   * 只有 Tool-calling 模式支持逐 tick 循环；Pipeline 模式应使用 runOnce。
   * 每次 tick 做一次 LLM 调用 → 解析回复 → 执行工具 → 积累 messages。
   *
   * 调用前必须先通过 assignTask 设置任务。
   */
  async runLoopTick(): Promise<AgentLoopTickResult> {
    // 没有任务 → idle
    if (!this.currentTask) {
      return { status: 'idle', reason: 'No pending task.' };
    }

    // 仅 tool-calling 模式支持逐 tick 循环
    if (!this.toolConfig || !this.toolRegistry || !this.loopMessages) {
      return {
        status: 'skipped',
        reason: 'Pipeline mode does not support tick-by-tick loop; use runOnce instead.',
      };
    }

    // 检查最大轮次
    const maxCalls = this.toolConfig.maxToolCalls ?? 20;
    if (this.loopRound >= maxCalls) {
      await this.finalizeLoop();
      return {
        status: 'completed',
        reason: `Max tool calls (${maxCalls}) reached.`,
      };
    }

    // 单步：一次 LLM 调用
    const response = await this.toolConfig.llm.completeWithTools({
      messages: this.loopMessages,
      tools: this.toolRegistry.toToolDefinitions(),
      tool_choice: 'auto',
    });

    this.loopRound++;

    if (response.tool_calls && response.tool_calls.length > 0) {
      // LLM 调用了工具 → 执行并将结果加入 messages
      const assistantMsg: ToolCallMessage = {
        role: 'assistant',
        content: response.content,
        tool_calls: response.tool_calls,
      };
      this.loopMessages.push(assistantMsg);

      for (const toolCall of response.tool_calls) {
        const tool = this.toolRegistry.get(toolCall.function.name);
        if (!tool) {
          this.loopMessages.push({
            role: 'tool',
            content: `Error: unknown tool "${toolCall.function.name}"`,
            tool_call_id: toolCall.id,
          });
          continue;
        }

        try {
          const args = JSON.parse(toolCall.function.arguments);
          const result = await tool.execute(args);

          // 记录最后一次 invoke_driver 的返回
          if (tool.name === 'invoke_driver') {
            this.lastDriverReturn = result as DriverReturn;
          }

          const content =
            typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result);

          this.loopMessages.push({
            role: 'tool',
            content,
            tool_call_id: toolCall.id,
          });
        } catch (error) {
          this.loopMessages.push({
            role: 'tool',
            content: `Error executing ${tool.name}: ${error instanceof Error ? error.message : String(error)}`,
            tool_call_id: toolCall.id,
          });
        }
      }
    } else {
      // LLM 返回文本（没有 tool_call）
      this.loopMessages.push({
        role: 'assistant',
        content: response.content,
      });

      // 检查 LLM 是否表示任务完成
      if (response.content && this.isTaskComplete(response.content)) {
        await this.finalizeLoop();
        return {
          status: 'completed',
          reason: 'Agent reported task complete.',
        };
      }
    }

    return { status: 'running', reason: `Round ${this.loopRound} completed.` };
  }

  /**
   * 将任务派发给 Agent，由 Agent 自行通过 runLoopTick 逐 tick 处理。
   *
   * 仅 Tool-calling 模式支持；Pipeline 模式仍使用 runOnce。
   *
   * @throws 如果 Agent 已有正在运行的任务
   */
  assignTask(task: AgentTaskRequest): void {
    if (this.currentTask) {
      throw new Error(
        `Agent ${this.memory.role_id} already has a running task (${this.currentTask.task_id}). ` +
          'Stop or wait for completion before assigning a new task.',
      );
    }

    this.currentTask = task;
    this.state = 'running';
    this.lastDriverReturn = undefined;
    this.loopRound = 0;
    this.lastCycleResult = null;

    if (this.toolConfig && this.toolRegistry) {
      // Tool-calling 模式：构建初始 messages
      const systemPromptContent =
        this.toolConfig.systemPrompt ??
        buildAgentSystemPrompt(this.memory, this.toolRegistry.toToolDefinitions());

      this.loopMessages = [
        {
          role: 'system',
          content: systemPromptContent,
        },
        {
          role: 'user',
          content: `Task: ${task.spec}`,
        },
      ];
    } else {
      // Pipeline 模式不使用 loopMessages
      this.loopMessages = null;
    }
  }

  /**
   * 单轮任务同步执行入口。
   *
   * - 配置了 toolConfig 时 → Tool-calling 模式（LLM 自主决策，内部逐 tick 循环）
   * - 未配置时 → Pipeline 模式（固定流程，向后兼容）
   */
  async runOnce(task: AgentTaskRequest): Promise<MemoryCycleResult> {
    this.state = 'running';
    try {
      if (this.toolConfig && this.toolRegistry) {
        return await this.runOnceWithTools(task);
      }
      return await runTaskMemoryCycle(this.memory, task, this.deps);
    } finally {
      this.state = 'sleeping';
    }
  }

  /**
   * Agent 自驱执行入口（区别于 runOnce —— runOnce 的 Pipeline 路径把提取/
   * 晋升等不属于 Agent 职责的流程也集成了进来）。
   *
   * - **Tool-calling 模式**：Agent 内部逐 tick 循环（LLM 自主决策 → 工具调用 →
   *   buffer 写入），**不含经验提取和技能晋升**（由离线 Processor 处理）
   * - **Pipeline 模式**：降级为 runTaskMemoryCycle（向后兼容）
   *
   * Tool-calling 路径的流程：
   * ```
   * assignTask → [runLoopTick × N] → writeToBuffer → 完成
   * ```
   */
  async executeTask(task: AgentTaskRequest): Promise<MemoryCycleResult> {
    this.state = 'running';
    try {
      if (this.toolConfig && this.toolRegistry) {
        this.assignTask(task);

        while (this.state === 'running') {
          const tick = await this.runLoopTick();
          if (tick.status === 'completed' || tick.status === 'idle') {
            break;
          }
        }

        const result = this.lastCycleResult;
        if (!result) {
          await this.finalizeLoop();
          return this.lastCycleResult!;
        }
        return result;
      }

      // Pipeline 降级
      return await runTaskMemoryCycle(this.memory, task, this.deps);
    } finally {
      this.state = 'sleeping';
    }
  }

  // ────────────────────────────────────────────
  // 内部方法
  // ────────────────────────────────────────────

  /**
   * 完成当前任务：写入 buffer → 清理状态。
   */
  private async finalizeLoop(): Promise<void> {
    if (!this.currentTask) return;

    const result = await this.writeToBuffer(
      this.currentTask,
      this.currentTask.task_id ?? createId('task'),
      this.currentTask.call_id ?? createId('call'),
      this.lastDriverReturn,
    );

    this.lastCycleResult = result;
    this.clearLoopState();
    this.state = 'sleeping';
  }

  /**
   * 清理持久循环状态（不改变 state）。
   */
  private clearLoopState(): void {
    this.currentTask = null;
    this.loopMessages = null;
    this.lastDriverReturn = undefined;
    this.loopRound = 0;
  }

  /**
   * LLM tool-calling 同步执行包装。
   *
   * 通过 assignTask + runLoopTick 循环实现，与持久循环共享同一套逻辑。
   */
  private async runOnceWithTools(task: AgentTaskRequest): Promise<MemoryCycleResult> {
    this.assignTask(task);

    while (this.state === 'running') {
      const tick = await this.runLoopTick();
      if (tick.status === 'completed' || tick.status === 'idle') {
        break;
      }
    }

    const result = this.lastCycleResult;
    if (!result) {
      // 兜底：正常情况下不应进入此分支
      await this.finalizeLoop();
      return this.lastCycleResult!;
    }
    return result;
  }

  /**
   * 检查 LLM 回复是否表示任务已完成。
   * 简单的启发式检查，后续可优化为 LLM 判断。
   */
  private isTaskComplete(content: string): boolean {
    const lower = content.toLowerCase();
    const finishIndicators = [
      'task complete',
      'task completed',
      'all done',
      'finished',
      '[done]',
      '任务完成',
      '已完成',
    ];
    return finishIndicators.some((indicator) => lower.includes(indicator));
  }

  /**
   * 写入 pending buffer，不做提取和晋升。
   *
   * 经验提取和技能晋升游离于 Agent 执行循环之外，由后续的 BufferProcessor
   * 异步处理，确保 Agent 的在线路径不被后处理阻塞。
   */
  private async writeToBuffer(
    task: AgentTaskRequest,
    task_id: string,
    call_id: string,
    lastDriverReturn: DriverReturn | undefined,
  ): Promise<MemoryCycleResult> {
    const persona = await this.memory.getPersona();
    const skills_before = await this.memory.listSkills();

    // 如果 LLM 没有调用 invoke_driver，构造一个占位 DriverReturn
    const driverReturn: DriverReturn = lastDriverReturn ?? {
      artifacts: [],
      summary: 'Task completed by top-level agent without driver invocation.',
      decisions: [],
      blockers: [],
      referenced_experiences: [],
      assumptions: [],
    };

    // 写入 pending buffer（仅存储，不处理）
    const ingested = await writePendingBuffer(
      this.memory,
      {
        task_id,
        task_description: task.spec,
        driver_return: driverReturn,
        source_task_id: task_id,
        source_driver: 'tool-calling-agent',
        received_at: nowTimestamp(),
        retry_count: 0,
        extraction_status: 'pending',
      },
      undefined,
    );

    return {
      agent_id: this.memory.role_id,
      persona,
      skills_before,
      retrieval: { skills: [], experiences: [] },
      driver_context: {
        task_instruction: task.spec,
        skills: [],
        experiences: [],
      },
      buffer_snapshot: ingested.snapshot,
      buffer_seq: ingested.seq,
      // 提取和晋升由离线 BufferProcessor 处理，这里返回空值
      extraction: {
        experiences: [],
        result: {
          experiences_created: 0,
          experiences_updated: 0,
          negative_experiences: 0,
          skills_promoted: 0,
        },
      },
      promotion: {
        check: {
          eligible: false,
          auto_approved: false,
          reasons: [],
          blocking_rules: ['extraction and promotion are handled offline'],
        },
      },
    };
  }
}
