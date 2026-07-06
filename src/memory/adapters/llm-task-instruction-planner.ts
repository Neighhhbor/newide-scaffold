/**
 * LlmTaskInstructionPlanner — TaskInstructionPlanner 的 LLM 实现
 *
 * 调用 LlmClient 从 task.spec 动态生成下发给 Driver 的 task_instruction，
 * 替代 MockTaskInstructionPlanner 的固定占位字符串。
 *
 * 规划流程：
 *   1. 组装 prompt（system 角色 + user 包含 spec）
 *   2. 调用 LLM 生成纯文本指令
 *   3. LLM 失败时降级为返回 spec 原文
 */
import type { LlmClient } from '../ports/llm-client';
import type { AgentTaskRequest } from '../agent-types';
export class LlmTaskInstructionPlanner {
  constructor(private readonly llm: LlmClient) {}

  plan = async (task: AgentTaskRequest): Promise<string> => {
    try {
      const raw = await this.llm.complete({
        messages: [
          {
            role: 'system',
            content: [
              'You are a task instruction planner for an AI agent system.',
              'Your job is to read the full task specification (spec) and produce a concise,',
              'execution-oriented instruction for a downstream Driver component.',
              '',
              'Rules:',
              '- Output plain text only (no JSON wrapping).',
              '- The instruction should be a focused subset or refinement of the spec,',
              '  optimized for execution rather than analysis.',
              '- Keep it under 3 paragraphs.',
              '- If the spec is already clear and actionable, you may repeat it verbatim.',
            ].join('\n'),
          },
          {
            role: 'user',
            content: `Produce a task instruction for the Driver based on this spec:\n\n${task.spec}`,
          },
        ],
      });

      const trimmed = raw.trim();
      return trimmed.length > 0 ? trimmed : task.spec;
    } catch {
      return task.spec;
    }
  };
}
