/**
 * DriverReturnConverter — 将方向 A 的 DriverRunResult 转换为方向 B 的 DriverReturn（六字段报告）
 *
 * 本模块解决 A→B 的数据形态转换问题：
 * - 方向 A 产出 DriverRunResult（artifacts + transcript + tool_events + diagnostics）
 * - 方向 B 需要 DriverReturn（artifacts + summary + decisions + blockers +
 *   referenced_experiences + assumptions）
 *
 * 提供两种转换策略，按优先级：
 * 1. parseDriverReturnFromTranscript — 从 transcript 中解析结构化 JSON 块
 *    （Driver 被 prompt 指示产出 <<<DRIVER_RETURN>>> 标记块）
 * 2. constructDriverReturnFromResult — 从 DriverRunResult 元数据构造
 *    （降级路径：无 transcript 或解析失败时的基本报告）
 */

import type { DriverReturn } from '../memory/schemas';
import type { DriverRunResult } from './contract';
import type { ArtifactRef } from '../core';

// ──────────────────────────────────────────────
// 类型定义
// ──────────────────────────────────────────────

/** DriverRunResult → DriverReturn 的转换函数签名（支持异步） */
export type DriverReturnConverter = (
  result: DriverRunResult,
  options?: DriverReturnConverterOptions,
) => DriverReturn | Promise<DriverReturn>;

/** 转换选项 */
export interface DriverReturnConverterOptions {
  /** 可选：Driver transcript 的文本内容（如果已加载） */
  transcriptText?: string;
  /** 可选：原始 DriverTask 指令 */
  instruction?: string;
  /** 可选：标记来源 Driver */
  sourceDriver?: string;
}

// ──────────────────────────────────────────────
// 策略1：从 transcript 解析结构化报告
// ──────────────────────────────────────────────

/**
 * 尝试从 Driver 的 transcript 文本中解析 DriverReturn。
 *
 * 支持两种格式：
 * - 完整 JSON 块：```json { "artifacts": ..., "summary": ..., ... } ```
 * - 六字段分块标记：<<<DRIVER_RETURN>>> ... <<<END_DRIVER_RETURN>>>
 *
 * @returns 解析出的 DriverReturn，解析失败则返回 null
 */
export function parseDriverReturnFromTranscript(transcriptText: string): DriverReturn | null {
  // 策略 A：匹配 <<<DRIVER_RETURN>>> ... <<<END_DRIVER_RETURN>>> 标记块
  const taggedMatch = transcriptText.match(
    /<<<DRIVER_RETURN>>>\s*([\s\S]*?)\s*<<<END_DRIVER_RETURN>>>/,
  );
  if (taggedMatch?.[1]) {
    try {
      return JSON.parse(taggedMatch[1]) as DriverReturn;
    } catch {
      // 继续尝试其他策略
    }
  }

  // 策略 B：匹配 JSON 代码块
  const jsonBlockMatch = transcriptText.match(
    /```(?:json)?\s*(\{[\s\S]*?"artifacts"[\s\S]*?"summary"[\s\S]*?\})\s*```/,
  );
  if (jsonBlockMatch?.[1]) {
    try {
      return JSON.parse(jsonBlockMatch[1]) as DriverReturn;
    } catch {
      // 继续尝试其他策略
    }
  }

  // 策略 C：匹配裸 JSON 对象（包含六字段特征）
  const bareJsonMatch = transcriptText.match(
    /\{\s*"artifacts"\s*:\s*\[[\s\S]*?"summary"\s*:\s*"[\s\S]*?"decisions"\s*:\s*\[/,
  );
  if (bareJsonMatch) {
    // 从匹配位置开始找完整的 JSON 对象
    const startIndex = bareJsonMatch.index!;
    const jsonText = extractJsonObject(transcriptText, startIndex);
    if (jsonText) {
      try {
        return JSON.parse(jsonText) as DriverReturn;
      } catch {
        // 解析失败
      }
    }
  }

  return null;
}

/**
 * 从字符串的指定位置开始提取完整 JSON 对象。
 * 通过大括号计数确保提取到完整的闭合对象。
 */
function extractJsonObject(text: string, startIndex: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = startIndex; i < text.length; i++) {
    const char = text[i]!;

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\' && inString) {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0) {
        return text.slice(startIndex, i + 1);
      }
    }
  }

  return null;
}

// ──────────────────────────────────────────────
// 策略2：从 DriverRunResult 元数据构造报告
// ──────────────────────────────────────────────

/**
 * 从 DriverRunResult 的元数据构造 DriverReturn。
 *
 * 这是当 Driver 没有产出结构化六字段报告时的降级策略：
 * - artifacts 直接映射
 * - summary 从 diagnostics + tool_events 拼接
 * - decisions 从 tool_events 推导基本决策链
 * - blockers 从 error / 失败状态推导
 * - referenced_experiences 和 assumptions 留空（无源数据）
 */
export function constructDriverReturnFromResult(
  result: DriverRunResult,
  options?: DriverReturnConverterOptions,
): DriverReturn {
  return {
    artifacts: mapArtifacts(result.artifacts),
    summary: buildSummary(result, options),
    decisions: buildDecisions(result, options),
    blockers: buildBlockers(result),
    referenced_experiences: [],
    assumptions: buildAssumptions(result),
  };
}

// ──────────────────────────────────────────────
// 默认转换器（策略组合）
// ──────────────────────────────────────────────

/**
 * 创建默认的 DriverReturnConverter。
 *
 * 优先尝试从 transcript 解析结构化报告，解析失败则降级到元数据构造。
 *
 * 使用示例：
 * ```ts
 * const converter = createDefaultDriverReturnConverter();
 * const driverReturn = converter(driverRunResult, { transcriptText });
 * ```
 */
export function createDefaultDriverReturnConverter(): DriverReturnConverter {
  return (result: DriverRunResult, options?: DriverReturnConverterOptions): DriverReturn => {
    // 尝试从 transcript 解析
    if (options?.transcriptText) {
      const parsed = parseDriverReturnFromTranscript(options.transcriptText);
      if (parsed) {
        return parsed;
      }
    }

    // 降级：元数据构造
    return constructDriverReturnFromResult(result, options);
  };
}

function mapArtifacts(artifacts: ArtifactRef[]): DriverReturn['artifacts'] {
  return artifacts.map((a) => ({
    type: a.type,
    path: a.uri,
    summary: a.metadata?.prompt_length
      ? `Produced by ${a.producer_id}, task ${a.task_id}`
      : `${a.type} artifact from ${a.producer_id}`,
  }));
}

function buildSummary(result: DriverRunResult, options?: DriverReturnConverterOptions): string {
  const parts: string[] = [];

  // 任务指令摘要
  if (options?.instruction) {
    const shortInstruction =
      options.instruction.length > 100
        ? options.instruction.slice(0, 100) + '...'
        : options.instruction;
    parts.push(`Task: "${shortInstruction}"`);
  }

  // 执行状态
  parts.push(
    `Driver "${result.diagnostics.driver_id}" finished with status "${result.status}" ` +
      `in ${result.diagnostics.duration_ms}ms.`,
  );

  // 产物摘要
  if (result.artifacts.length > 0) {
    const artifactList = result.artifacts.map((a) => `${a.type}(${a.uri})`).join(', ');
    parts.push(`Produced ${result.artifacts.length} artifact(s): ${artifactList}.`);
  } else {
    parts.push('No artifacts produced.');
  }

  // 工具调用摘要
  if (result.tool_events.length > 0) {
    const toolSummary = result.tool_events
      .map((t) => `${t.tool_name}: ${t.status} (${t.summary})`)
      .join('; ');
    parts.push(`Tool events: ${toolSummary}.`);
  }

  // 诊断备注
  if (result.diagnostics.notes.length > 0) {
    parts.push(`Notes: ${result.diagnostics.notes.join('; ')}.`);
  }

  // 错误信息
  if (result.error) {
    parts.push(
      `Error: [${result.error.code}] ${result.error.message}` +
        `${result.error.retryable ? ' (retryable)' : ''}.`,
    );
  }

  return parts.join(' ');
}

function buildDecisions(
  result: DriverRunResult,
  options?: DriverReturnConverterOptions,
): DriverReturn['decisions'] {
  const decisions: DriverReturn['decisions'] = [];

  // 从 tool_events 推导基本决策点
  for (const event of result.tool_events) {
    decisions.push({
      point: `Tool execution: ${event.tool_name}`,
      options: ['execute', 'skip'],
      chosen: event.status === 'completed' ? 'execute' : 'skip',
      reason: event.summary || `Tool ${event.tool_name} ${event.status}.`,
    });
  }

  // Driver 级别的关键决策
  if (options?.instruction) {
    decisions.push({
      point: 'Task execution approach',
      options: ['delegate_to_driver', 'handle_directly'],
      chosen: 'delegate_to_driver',
      reason: `Task "${options.instruction.slice(0, 80)}" delegated to driver "${result.diagnostics.driver_id}".`,
    });
  }

  if (result.status === 'failed' && result.error) {
    decisions.push({
      point: 'Error handling',
      options: ['retry', 'fail'],
      chosen: result.error.retryable ? 'retry' : 'fail',
      reason: `Error [${result.error.code}]: ${result.error.message}`,
    });
  }

  return decisions;
}

function buildBlockers(result: DriverRunResult): DriverReturn['blockers'] {
  const blockers: DriverReturn['blockers'] = [];

  if (result.error) {
    blockers.push({
      blocker: result.error.message,
      attempts: result.diagnostics.notes,
      resolution: result.error.retryable
        ? 'Pending retry (error is retryable)'
        : 'Task failed (error is not retryable)',
      resolved: false,
    });
  }

  if (result.status === 'cancelled') {
    blockers.push({
      blocker: 'Driver execution was cancelled',
      attempts: [],
      resolution: 'Task cancelled externally',
      resolved: true,
    });
  }

  if (result.status === 'interrupted') {
    blockers.push({
      blocker: 'Driver execution was interrupted',
      attempts: [],
      resolution: 'Pending resumption or retry',
      resolved: false,
    });
  }

  return blockers;
}

function buildAssumptions(result: DriverRunResult): DriverReturn['assumptions'] {
  const assumptions: DriverReturn['assumptions'] = [];

  assumptions.push({
    assumption: `Driver "${result.diagnostics.driver_id}" correctly executed the task`,
    risk_if_wrong: 'Output may be incomplete or incorrect; requires manual review of artifacts',
  });

  if (result.artifacts.length > 0) {
    assumptions.push({
      assumption: `All ${result.artifacts.length} artifact(s) are valid and complete`,
      risk_if_wrong: 'Missing or corrupted artifacts could cause downstream failures',
    });
  }

  if (result.status !== 'succeeded') {
    assumptions.push({
      assumption: `Driver status "${result.status}" accurately reflects the execution outcome`,
      risk_if_wrong: 'Status mismatch could lead to incorrect flow decisions (retry vs. fail)',
    });
  }

  return assumptions;
}
