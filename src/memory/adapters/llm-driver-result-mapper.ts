/**
 * LlmDriverResultMapper — DriverResultMapper 的 LLM 实现
 *
 * 调用 LlmClient 从 DriverRunResult 中提取 5 字段结构化报告
 * （artifacts / summary / decisions / blockers / assumptions）。
 * referenced_experiences 由确定性逻辑构建，不消耗 LLM 调用。
 *
 * ## 映射流程
 *
 * 1. 组装 prompt：将 DriverRunResult 的 tool_events、diagnostics、error、
 *    artifacts 序列化为 LLM 可读文本
 * 2. 调用 LLM，要求 JSON 输出（5 字段）
 * 3. 手动校验返回内容的结构完整性
 * 4. 校验通过 → 合并确定性的 referenced_experiences → 返回完整 DriverReturn
 * 5. 校验失败/调用异常 → 降级到 mapRunResultToDriverReturn（启发式映射器）
 *
 * ## 使用方式
 *
 * ```typescript
 * import { LiteLLMClientAdapter } from './litellm-client-adapter';
 * import { LlmDriverResultMapper } from './llm-driver-result-mapper';
 * import { DriverAdapter } from './driver-adapter';
 *
 * const llm = new LiteLLMClientAdapter();
 * const adapter = new DriverAdapter({
 *   driverRuntime: ... ,
 *   mapResult: new LlmDriverResultMapper(llm).map,
 * });
 * ```
 */
import type { DriverRunResult } from '../../driver';
import type { LlmClient } from '../ports/llm-client';
import type { DriverInvokeInput } from '../runtime/agent-run-deps';
import type { DriverReturn } from '../schemas';
import type { DriverResultMapper } from './driver-adapter';
import { mapRunResultToDriverReturn } from './driver-adapter';

// ═══════════════════════════════════════════════════════════════
// LLM response schema
// ═══════════════════════════════════════════════════════════════

interface LlmArtifact {
  type: string;
  path: string;
  summary: string;
}

interface LlmDecision {
  point: string;
  options: string[];
  chosen: string;
  reason: string;
}

interface LlmBlocker {
  blocker: string;
  attempts: string[];
  resolution: string;
  resolved: boolean;
}

interface LlmAssumption {
  assumption: string;
  risk_if_wrong: string;
}

interface LlmMapperResponse {
  artifacts: LlmArtifact[];
  summary: string;
  decisions: LlmDecision[];
  blockers: LlmBlocker[];
  assumptions: LlmAssumption[];
}

function parseLlmResponse(raw: string): LlmMapperResponse {
  const parsed = JSON.parse(raw) as unknown;

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('LLM response is not a JSON object');
  }

  const obj = parsed as Record<string, unknown>;

  if (!Array.isArray(obj.artifacts)) {
    throw new Error('LLM response missing artifacts array');
  }
  if (typeof obj.summary !== 'string' || obj.summary.length === 0) {
    throw new Error('LLM response missing or invalid summary');
  }
  if (!Array.isArray(obj.decisions)) {
    throw new Error('LLM response missing decisions array');
  }
  if (!Array.isArray(obj.blockers)) {
    throw new Error('LLM response missing blockers array');
  }
  if (!Array.isArray(obj.assumptions)) {
    throw new Error('LLM response missing assumptions array');
  }

  // Validate each artifact
  for (const [i, a] of (obj.artifacts as unknown[]).entries()) {
    const art = a as Record<string, unknown>;
    if (typeof art.type !== 'string') throw new Error(`Artifact #${i} missing type`);
    if (typeof art.path !== 'string') throw new Error(`Artifact #${i} missing path`);
    if (typeof art.summary !== 'string') throw new Error(`Artifact #${i} missing summary`);
  }

  // Validate each decision
  for (const [i, d] of (obj.decisions as unknown[]).entries()) {
    const dec = d as Record<string, unknown>;
    if (typeof dec.point !== 'string') throw new Error(`Decision #${i} missing point`);
    if (!Array.isArray(dec.options)) throw new Error(`Decision #${i} missing options array`);
    if (typeof dec.chosen !== 'string') throw new Error(`Decision #${i} missing chosen`);
    if (typeof dec.reason !== 'string') throw new Error(`Decision #${i} missing reason`);
  }

  // Validate each blocker
  for (const [i, b] of (obj.blockers as unknown[]).entries()) {
    const blk = b as Record<string, unknown>;
    if (typeof blk.blocker !== 'string') throw new Error(`Blocker #${i} missing blocker`);
    if (!Array.isArray(blk.attempts)) throw new Error(`Blocker #${i} missing attempts array`);
    if (typeof blk.resolution !== 'string') throw new Error(`Blocker #${i} missing resolution`);
    if (typeof blk.resolved !== 'boolean') throw new Error(`Blocker #${i} missing resolved`);
  }

  // Validate each assumption
  for (const [i, a] of (obj.assumptions as unknown[]).entries()) {
    const asm = a as Record<string, unknown>;
    if (typeof asm.assumption !== 'string') throw new Error(`Assumption #${i} missing assumption`);
    if (typeof asm.risk_if_wrong !== 'string')
      throw new Error(`Assumption #${i} missing risk_if_wrong`);
  }

  return obj as unknown as LlmMapperResponse;
}

// ═══════════════════════════════════════════════════════════════
// Prompt builder
// ═══════════════════════════════════════════════════════════════

const SYSTEM_PROMPT = `You are a structured report extractor. Your job is to read a Driver execution result and produce a structured 5-field report (JSON). The Driver is an AI coding agent that executes tasks by calling tools.

Extraction rules:

1. **artifacts**: List all produced files/artifacts. For each, include:
   - type: the artifact type (e.g., "patch", "file", "test_result")
   - path: the artifact URI or file path
   - summary: a brief one-line description of what this artifact contains

2. **summary**: Write 3-5 sentences summarizing what the Driver did. Synthesize from tool events, diagnostics notes, and the overall execution. Focus on the outcome and key actions.

3. **decisions**: Identify meaningful decisions the Driver made (not just tool invocations). For each decision, include:
   - point: what decision was being made (a specific juncture, not "Driver invoked tool X")
   - options: what alternatives were considered (at least 2)
   - chosen: which option was selected
   - reason: why that option was chosen

   Important: Tool calls alone are not decisions. A "decision" is a strategic choice point — e.g., "choose between refactoring vs. patching", "choose between SQL parameterization vs. input escaping". If no clear decisions can be inferred, return an empty array.

4. **blockers**: List any obstacles the Driver encountered and how they were resolved. For each blocker:
   - blocker: what the obstacle was
   - attempts: what was tried to resolve it
   - resolution: how it was ultimately resolved (or "Not resolved" if still open)
   - resolved: true if the blocker was overcome, false otherwise

5. **assumptions**: List assumptions the Driver appears to have made during execution. For each assumption:
   - assumption: what was assumed
   - risk_if_wrong: what the consequence would be if this assumption is incorrect

Output JSON only with this exact format:
{
  "artifacts": [{ "type": "...", "path": "...", "summary": "..." }],
  "summary": "...",
  "decisions": [{ "point": "...", "options": ["..."], "chosen": "...", "reason": "..." }],
  "blockers": [{ "blocker": "...", "attempts": ["..."], "resolution": "...", "resolved": false }],
  "assumptions": [{ "assumption": "...", "risk_if_wrong": "..." }]
}

Always produce valid JSON. All five fields must be present.`;

function buildMapperPrompt(result: DriverRunResult, input: DriverInvokeInput): string {
  const sections: string[] = [];

  // -- Task context
  sections.push(`## Task Instruction\n${input.driver_context.task_instruction}`);

  // -- Execution status
  sections.push(`## Execution Status\nStatus: ${result.status}`);
  sections.push(`Driver: ${result.diagnostics.driver_id}`);
  sections.push(`Duration: ${result.diagnostics.duration_ms}ms`);

  // -- Diagnostics notes
  if (result.diagnostics.notes.length > 0) {
    sections.push(
      `\n## Diagnostics Notes\n${result.diagnostics.notes.map((n) => `- ${n}`).join('\n')}`,
    );
  }

  // -- Error (if present)
  if (result.error) {
    sections.push(
      `\n## Error\n- Code: ${result.error.code}\n- Message: ${result.error.message}\n- Retryable: ${result.error.retryable}`,
    );
  }

  // -- Artifacts
  if (result.artifacts.length > 0) {
    const artifactList = result.artifacts.map(
      (a) =>
        `- type: ${a.type}\n  uri: ${a.uri}\n  summary: ${
          a.metadata && typeof a.metadata === 'object' && 'summary' in a.metadata
            ? String((a.metadata as Record<string, unknown>).summary)
            : '(no summary)'
        }`,
    );
    sections.push(`\n## Produced Artifacts\n${artifactList.join('\n')}`);
  } else {
    sections.push('\n## Produced Artifacts\n(none)');
  }

  // -- Tool events
  if (result.tool_events.length > 0) {
    const eventList = result.tool_events.map(
      (e) => `- [${e.status}] ${e.tool_name}${e.summary ? `: ${e.summary}` : ''}`,
    );
    sections.push(`\n## Tool Events\n${eventList.join('\n')}`);
  } else {
    sections.push('\n## Tool Events\n(none)');
  }

  return sections.join('\n');
}

// ═══════════════════════════════════════════════════════════════
// Referenced experiences (deterministic — no LLM)
// ═══════════════════════════════════════════════════════════════

/**
 * 构建引用经验的反馈列表。
 *
 * 与 driver-adapter 中的 buildReferencedExperiences 逻辑一致：
 * 默认所有经验标记为 applied: true, effectiveness: "not_applicable"，
 * 因为 Driver 的原始输出（DriverRunResult）不包含对每条经验的有效性评估。
 * 只有当 Driver 通过 memory_report 字段显式返回时才可获得真实评估。
 */
function buildReferencedExperiences(
  input: DriverInvokeInput,
): DriverReturn['referenced_experiences'] {
  return input.driver_context.experiences.map((exp) => ({
    experience_id: exp.id,
    applied: true,
    effectiveness: 'not_applicable' as const,
    note:
      'Automatic mapping: Driver did not provide explicit effectiveness feedback. ' +
      'Update to a Driver that supports memory_report for accurate evaluation.',
  }));
}

// ═══════════════════════════════════════════════════════════════
// Main mapper
// ═══════════════════════════════════════════════════════════════

/**
 * LlmDriverResultMapper — 使用 LLM 从 DriverRunResult 提取 5 字段报告。
 *
 * 遵循方向B 所有 LLM consumer 的统一模式：
 * system prompt + user prompt → JSON 输出 → 手动校验 → 降级兜底。
 *
 * referenced_experiences 不使用 LLM——该字段由输入中的
 * driver_context.experiences 确定性构建（与启发式映射器行为一致）。
 */
export class LlmDriverResultMapper {
  constructor(private readonly llm: LlmClient) {}

  /**
   * DriverResultMapper 兼容的函数签名。
   *
   * 可直接作为 DriverAdapterOptions.mapResult 传入：
   *
   * ```typescript
   * new DriverAdapter({
   *   driverRuntime: ... ,
   *   mapResult: new LlmDriverResultMapper(llm).map,
   * });
   * ```
   */
  readonly map: DriverResultMapper = async (
    result: DriverRunResult,
    input: DriverInvokeInput,
  ): Promise<DriverReturn> => {
    try {
      const userPrompt = buildMapperPrompt(result, input);

      const raw = await this.llm.complete({
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        responseFormat: { type: 'json_object' },
      });

      const parsed = parseLlmResponse(raw);

      return {
        artifacts: parsed.artifacts,
        summary: parsed.summary,
        decisions: parsed.decisions,
        blockers: parsed.blockers,
        referenced_experiences: buildReferencedExperiences(input),
        assumptions: parsed.assumptions,
      };
    } catch {
      // LLM 调用失败或响应格式异常 → 降级到启发式映射器
      return mapRunResultToDriverReturn(result, input);
    }
  };
}
