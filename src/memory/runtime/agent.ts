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
 * ## 向后兼容
 *
 * - `new Agent(memory)` 或 `new Agent(memory, deps)` → Pipeline 模式
 * - `new Agent(memory, deps, { llm, tools })` → Tool-calling 模式
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
  /** 单次 runOnce 最大 tool-calling 轮次（防死循环，默认 20） */
  maxToolCalls?: number;
}

// ──────────────────────────────────────────────
// Agent 类
// ──────────────────────────────────────────────

export class Agent {
  private state: AgentLoopState = 'idle';
  private readonly toolConfig: AgentToolConfig | undefined;
  private readonly toolRegistry: ToolRegistry | undefined;

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

  /**
   * 目标态持久 run loop 入口占位。
   *
   * 当前不会启动后台 worker 或任务队列，只把 Agent 放入 sleeping 状态，等待
   * AgentManager.submitTask 通过 MVP runOnce 路径显式派发任务。
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
  }

  async bid(_task: AgentTaskRequest): Promise<number> {
    return 0.5;
  }

  /**
   * 目标态持久 run loop 的单步执行占位。
   */
  async runLoopTick(): Promise<AgentLoopTickResult> {
    return {
      status: 'skipped',
      reason:
        'Persistent agent run loop is not implemented yet; runOnce is the MVP synchronous path.',
    };
  }

  /**
   * 单轮任务同步执行入口。
   *
   * - 配置了 toolConfig 时 → Tool-calling 模式（LLM 自主决策）
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

  // ────────────────────────────────────────────
  // Tool-calling 模式
  // ────────────────────────────────────────────

  /**
   * LLM tool-calling 执行主循环。
   *
   * 流程：
   * 1. 构建 system prompt（含工具描述）+ user message（含 task spec）
   * 2. LLM 自主 tool-calling 循环：
   *    a. LLM 返回 tool_call → 执行对应工具 → 结果加入 messages → 继续
   *    b. LLM 返回文本 → 加入 messages → 继续（LLM 可能在思考）
   *    c. 达到 maxToolCalls 或 LLM 输出完成信号 → 退出
   * 3. 后处理：从最终结果构建 BufferSnapshot → 提取经验 → 晋升技能
   */
  private async runOnceWithTools(task: AgentTaskRequest): Promise<MemoryCycleResult> {
    const config = this.toolConfig!;
    const registry = this.toolRegistry!;
    const task_id = task.task_id ?? createId('task');
    const call_id = task.call_id ?? createId('call');

    // 1. 构建初始 messages
    const messages: ToolCallMessage[] = [
      {
        role: 'system',
        content:
          config.systemPrompt ??
          [
            'You are an AI agent with access to tools. Your job is to complete the task.',
            '',
            'Available tools:',
            ...registry
              .toToolDefinitions()
              .map((def) => `- ${def.function.name}: ${def.function.description}`),
            '',
            'Rules:',
            '- Use query_memory to check relevant past experiences and skills before acting.',
            '- Use invoke_driver to dispatch concrete sub-tasks to the Driver Agent.',
            '- Keep track of what the driver returns and use it to inform next steps.',
            '- When the task is complete, summarize the result clearly.',
          ].join('\n'),
      },
      {
        role: 'user',
        content: `Task: ${task.spec}`,
      },
    ];

    // 2. Tool-calling 循环
    const maxCalls = config.maxToolCalls ?? 20;
    let lastDriverReturn: DriverReturn | undefined;

    for (let round = 0; round < maxCalls; round++) {
      const response = await config.llm.completeWithTools({
        messages,
        tools: registry.toToolDefinitions(),
        tool_choice: 'auto',
      });

      if (response.tool_calls && response.tool_calls.length > 0) {
        // 2a. LLM 调用了工具 → 执行
        const assistantMsg: ToolCallMessage = {
          role: 'assistant',
          content: response.content,
          tool_calls: response.tool_calls,
        };
        messages.push(assistantMsg);

        for (const toolCall of response.tool_calls) {
          const tool = registry.get(toolCall.function.name);
          if (!tool) {
            messages.push({
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
              lastDriverReturn = result as DriverReturn;
            }

            const content =
              typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result);

            messages.push({
              role: 'tool',
              content,
              tool_call_id: toolCall.id,
            });
          } catch (error) {
            messages.push({
              role: 'tool',
              content: `Error executing ${tool.name}: ${error instanceof Error ? error.message : String(error)}`,
              tool_call_id: toolCall.id,
            });
          }
        }
      } else {
        // 2b. LLM 返回文本（没有 tool_call）
        messages.push({
          role: 'assistant',
          content: response.content,
        });

        // 检查 LLM 是否表示任务完成
        if (response.content && this.isTaskComplete(response.content)) {
          break;
        }
      }
    }

    // 3. 后处理：构建 buffer → 提取经验 → 晋升技能
    return this.finalizeWithPostProcess(task, task_id, call_id, lastDriverReturn, messages);
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
   * 后处理：将 LLM tool-calling 的结果转换为 MemoryCycleResult。
   *
   * 使用现有的 BufferRepository + ExperienceExtractor + SkillPromotion 链路，
   * 确保与 Pipeline 模式的一致性。
   */
  private async finalizeWithPostProcess(
    task: AgentTaskRequest,
    task_id: string,
    call_id: string,
    lastDriverReturn: DriverReturn | undefined,
    _messages: ToolCallMessage[],
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

    // 写入 buffer
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

    // 从 buffer 提取经验 + 晋升技能（复用现有流程）
    const pending = await this.memory.getPendingBuffer(ingested.seq);
    if (!pending) {
      throw new Error(`Pending buffer not found: seq=${ingested.seq}`);
    }

    const extraction = await this.deps.extractor.extract(pending.snapshot, pending.agentContext);
    for (const experience of extraction.experiences) {
      await this.memory.saveExperience(experience);
    }

    const promotion = await this.deps.promote(this.memory, task, extraction.experiences);
    if (promotion.skill) {
      extraction.result.skills_promoted = 1;
    }

    await this.memory.markBufferProcessed(ingested.seq);

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
      extraction,
      promotion,
    };
  }
}
