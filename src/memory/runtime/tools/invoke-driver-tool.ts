/**
 * InvokeDriverTool — Driver Agent 调用工具（插槽）
 *
 * 将 Driver Agent 的执行能力暴露为 Tool，供顶层 Agent 的 LLM 调用。
 * driver 的具体实现由外部模块通过 DriverHandler 注入，
 * memory 模块只定义契约，不关心 driver 内部实现（Claude/Codex/Gemini 等）。
 *
 * ## 使用示例
 *
 * ```ts
 * // 外部模块注入 driver handler
 * const driverTool = new InvokeDriverTool(async (task) => {
 *   // 调用 Claude API、启动子进程、或调用其他 agent
 *   return { summary, artifacts, decisions, blockers };
 * });
 * ```
 */
import type { Tool } from '../tool';
import type { DriverReturn } from '../../schemas';

// ──────────────────────────────────────────────
// 类型定义
// ──────────────────────────────────────────────

/** 下发给 Driver Agent 的子任务 */
export interface DriverTask {
  /** Driver 要执行的具体指令 */
  instruction: string;
  /** 可选上下文（如相关技能/经验的 content） */
  context?: {
    skills?: string[];
    experiences?: string[];
  };
}

/**
 * Driver Handler 函数签名。
 * 外部模块实现此签名来提供具体的 driver 执行逻辑。
 * memory 模块只依赖此签名，不关心内部实现。
 */
export type DriverHandler = (task: DriverTask) => Promise<DriverReturn>;

// ──────────────────────────────────────────────
// Tool 实现
// ──────────────────────────────────────────────

export class InvokeDriverTool implements Tool<DriverTask, DriverReturn> {
  readonly name = 'invoke_driver';
  readonly description =
    '向 Driver Agent 提交一个待执行的子任务，返回结构化的执行结果。' +
    'Driver Agent 负责具体执行工作，不会污染顶层上下文。' +
    '调用后你会收到包括 artifacts、summary、decisions、blockers 等字段的结构化报告。';
  readonly inputSchema = {
    type: 'object',
    properties: {
      instruction: {
        type: 'string',
        description: 'Driver 要执行的具体指令，应清晰明确、可执行',
      },
      context: {
        type: 'object',
        properties: {
          skills: {
            type: 'array',
            items: { type: 'string' },
            description: '相关技能内容列表，帮助 Driver 理解背景',
          },
          experiences: {
            type: 'array',
            items: { type: 'string' },
            description: '相关经验内容列表，帮助 Driver 避免重复错误',
          },
        },
        description: '可选的上下文信息，辅助 Driver 执行',
      },
    },
    required: ['instruction'],
  };

  constructor(private readonly handler: DriverHandler) {}

  async execute(input: DriverTask): Promise<DriverReturn> {
    return this.handler(input);
  }
}
