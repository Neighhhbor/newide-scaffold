/**
 * LlmContextCleaner — AgentContextCleaner 的 LLM 实现
 *
 * 调用 LlmClient 将顶层 Agent 原始上下文（raw_context）与 Driver 返回报告
 * 压缩为结构化 AgentContextSnapshot（含 thinking_trace / planning_trace），
 * 替代 NullContextCleaner 的空实现。
 *
 * 清理流程：
 *   1. 组装 prompt（raw_context + driver_return 摘要）
 *   2. 调用 LLM 输出 JSON（thinking_trace + planning_trace）
 *   3. Zod 校验 → 映射为 AgentContextSnapshot
 *   4. 校验失败/异常 → 返回 null（与 NullContextCleaner 行为一致）
 */
import { randomUUID } from 'node:crypto';
import { nowTimestamp } from '../../core';
import type { LlmClient } from '../ports/llm-client';
import type { AgentContextCleaner, AgentContextCleanInput } from '../ports/agent-context-cleaner';
import type { AgentContextSnapshot } from '../schemas';

// ═══════════════════════════════════════════
//  Response schema
// ═══════════════════════════════════════════

interface LlmCleanResponse {
  thinking_trace: string;
  planning_trace: string;
}

function parseLlmResponse(raw: string): LlmCleanResponse {
  const parsed = JSON.parse(raw) as unknown;

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('LLM response is not a JSON object');
  }

  const { thinking_trace, planning_trace } = parsed as Record<string, unknown>;

  if (typeof thinking_trace !== 'string' || thinking_trace.length === 0) {
    throw new Error('LLM response missing or invalid thinking_trace');
  }
  if (typeof planning_trace !== 'string' || planning_trace.length === 0) {
    throw new Error('LLM response missing or invalid planning_trace');
  }

  return { thinking_trace, planning_trace };
}

// ═══════════════════════════════════════════
//  Prompt builder
// ═══════════════════════════════════════════

function buildCleanPrompt(input: AgentContextCleanInput): string {
  const sections: string[] = [];

  sections.push(`## Raw Agent Context\n${input.raw_context}`);

  if (input.driver_returns.length > 0) {
    const driverSummary = input.driver_returns
      .map(
        (dr) =>
          `- Call: ${dr.call_id}\n  Driver: ${dr.driver_id}\n  Summary: ${dr.driver_return.summary}\n  Decisions: ${dr.driver_return.decisions.length}\n  Blockers: ${dr.driver_return.blockers.length}`,
      )
      .join('\n');
    sections.push(`## Driver Calls\n${driverSummary}`);
  }

  return sections.join('\n\n');
}

const SYSTEM_PROMPT = `You are a context cleaner for an AI agent system. Your job is to compress raw agent execution context into a structured summary.

Extract two things from the raw context:

1. thinking_trace — the agent's reasoning process: what it considered, why it made choices, any chain-of-thought or analysis. This captures the "why" behind decisions.

2. planning_trace — the agent's plan or task decomposition: what steps it identified, in what order, any sub-tasks. This captures the "how" — the execution structure.

Output JSON only with this exact format:
{
  "thinking_trace": "concise reasoning summary",
  "planning_trace": "concise plan summary"
}`;

// ═══════════════════════════════════════════
//  Token estimation helpers
// ═══════════════════════════════════════════

function estimateTokenCount(text: string): number {
  // Rough estimate: ~4 chars per token for English text
  return Math.max(1, Math.round(text.length / 4));
}

// ═══════════════════════════════════════════
//  Main cleaner
// ═══════════════════════════════════════════

export class LlmContextCleaner implements AgentContextCleaner {
  constructor(private readonly llm: LlmClient) {}

  async clean(input: AgentContextCleanInput): Promise<AgentContextSnapshot | null> {
    try {
      const userPrompt = buildCleanPrompt(input);

      const raw = await this.llm.complete({
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        responseFormat: { type: 'json_object' },
      });

      const parsed = parseLlmResponse(raw);

      const now = nowTimestamp();
      const originalTokens = estimateTokenCount(input.raw_context);
      const cleanedTokens =
        estimateTokenCount(parsed.thinking_trace) + estimateTokenCount(parsed.planning_trace);

      return {
        snapshot_id: randomUUID(),
        source_task_id: input.source_task_id,
        agent_id: input.agent_id,
        thinking_trace: parsed.thinking_trace,
        planning_trace: parsed.planning_trace,
        driver_calls: input.driver_returns.map((dr) => ({
          call_id: dr.call_id,
          driver_id: dr.driver_id,
          driver_return_ref: `report_${dr.call_id}.json`,
        })),
        cleaned_at: now,
        original_token_count: originalTokens,
        cleaned_token_count: cleanedTokens,
        compression_ratio: originalTokens > 0 ? cleanedTokens / originalTokens : 0,
      };
    } catch {
      return null;
    }
  }
}
