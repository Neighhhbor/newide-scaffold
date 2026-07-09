/**
 * DriverAdapter —— 方向A Driver 接入 Agent Memory 的适配层
 *
 * 将方向A的 DriverRuntimeHandle（sendPrompt → DriverRunResult）
 * 适配为方向B的 invokeDriver 函数签名（DriverInvokeInput → DriverReturn）。
 *
 * ## 职责边界
 *
 * - 方向A 关注"如何与 Agent 通信"（ACP/PTY/认证/传输）
 * - 方向B 关注"如何使用 Driver 输出提取经验"（6 字段报告）
 * - 本适配层做中间的契约转换：序列化 → 调用 → 结果映射
 *
 * ## 三层转换
 *
 * 1. serializeDriverContext: 结构化 DriverContext → 单一 prompt 字符串
 * 2. sendPrompt: 通过 DriverRuntimeHandle 下发给外部 Agent
 * 3. mapRunResultToDriverReturn: DriverRunResult → 6 字段 DriverReturn
 *
 * ## 默认行为与可定制性
 *
 * 序列化器和映射器均可通过构造选项注入自定义实现：
 * - serializeContext: 控制 prompt 模板格式（Markdown/ACP Agent Card 等）
 * - mapResult: 控制结果映射精度（启发式 vs LLM 辅助提取）
 */
import { SCHEMA_VERSION, createId, nowTimestamp, type ArtifactRef } from '../../core';
import type { DriverRuntimeHandle, DriverRunResult } from '../../driver';
import type { DriverInvokeInput } from '../runtime/agent-run-deps';
import type { DriverReturn, ExperienceRecord, SkillRecord } from '../schemas';
import type { DriverContext } from '../types';

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

/**
 * DriverContext → prompt 字符串序列化器。
 *
 * 将 Agent Memory 模块的结构化上下文（task_instruction + Skills + Experiences）
 * 转换为外部 Driver 能理解的自然语言 prompt。
 */
export type DriverContextSerializer = (context: DriverContext, input: DriverInvokeInput) => string;

/**
 * DriverRunResult → DriverReturn 映射器。
 *
 * 将方向A Driver 返回的通用执行结果转换为方向B 所需的 6 字段结构化报告。
 * 异步以支持未来通过 LLM 辅助提取。
 */
export type DriverResultMapper = (
  result: DriverRunResult,
  input: DriverInvokeInput,
) => DriverReturn | Promise<DriverReturn>;

/**
 * DriverAdapter 构造选项。
 *
 * 所有字段均可选——缺省时使用默认序列化器和映射器。
 */
export interface DriverAdapterOptions {
  /** 方向A Driver 运行时实例（唯一必填项） */
  driverRuntime: DriverRuntimeHandle;
  /** 自定义 prompt 序列化策略 */
  serializeContext?: DriverContextSerializer;
  /** 自定义结果映射策略 */
  mapResult?: DriverResultMapper;
}

// ═══════════════════════════════════════════════════════════════
// 默认序列化器：DriverContext → prompt 字符串
// ═══════════════════════════════════════════════════════════════

/**
 * 将 DriverContext 序列化为 Driver 可读的 Markdown prompt。
 *
 * ## 输出格式
 *
 * ```
 * ## Task
 * {task_instruction}
 *
 * ## Reference Skills
 * ### Skill: {description}
 * {content}
 *
 * ## Reference Experiences
 * ### Experience (confidence: {value}): {description}
 * {content}
 * ⚠️ Linked caveats: {negative_exp content}
 *
 * ## Reporting
 * After completing the task, please report in your output:
 * - Which reference materials (by ID) were used
 * - Whether each was effective (fully_effective / partially_effective / ineffective)
 * - Any blockers encountered and their resolution
 * ```
 *
 * 序列化顺序：Skills → Experiences（技能优先，代表更可靠的知识）。
 * 负经验关联以 "⚠️ Linked caveats" 形式内联于正经验之下。
 *
 * @param context - 包含 task_instruction、skills[]、experiences[] 的结构化上下文
 * @param _input  - 完整的 DriverInvokeInput（保留给自定义序列化器使用，默认不消费）
 * @returns 格式化的 prompt 字符串
 */
export function serializeDriverContext(context: DriverContext, _input: DriverInvokeInput): string {
  const sections: string[] = [];

  // ── §1 任务指令 ──
  sections.push('## Task');
  sections.push(context.task_instruction);
  sections.push('');

  // ── §2 参考技能 ──
  if (context.skills.length > 0) {
    sections.push('## Reference Skills');
    sections.push('The following skills have been validated through repeated successful use.');
    sections.push('');
    for (const skill of context.skills) {
      sections.push(formatSkillSection(skill));
    }
  }

  // ── §3 参考经验 ──
  if (context.experiences.length > 0) {
    sections.push('## Reference Experiences');
    sections.push(
      'The following experiences were extracted from past tasks. Use them as guidance, ' +
        'but adapt to the current context.',
    );
    sections.push('');
    for (const exp of context.experiences) {
      sections.push(formatExperienceSection(exp));
    }
  }

  // ── §4 结果报告指令 ──
  sections.push('## Reporting');
  sections.push('After completing the task, include a brief report section with:');
  sections.push('1. A summary of what was done (3-5 sentences)');
  sections.push('2. Key decisions you made (option considered, option chosen, reason)');
  sections.push('3. Any blockers encountered and how they were resolved');
  sections.push(
    '4. For each reference material used, indicate whether it was: ' +
      'fully_effective / partially_effective / ineffective / not_applicable',
  );
  sections.push('5. Any assumptions you made and what the risk would be if wrong');

  return sections.join('\n');
}

/**
 * 将单条 SkillRecord 格式化为 prompt 段落。
 *
 * 输出包含 skill_id（供 Driver 反馈引用）、描述和完整内容。
 */
function formatSkillSection(skill: SkillRecord): string {
  const lines: string[] = [];
  lines.push(`### Skill [${skill.id}]: ${skill.description}`);
  lines.push(`**Version**: ${skill.version} | **Status**: ${skill.review_status}`);
  if (skill.tags.length > 0) {
    lines.push(`**Tags**: ${skill.tags.join(', ')}`);
  }
  lines.push('');
  lines.push(skill.content);
  lines.push('');

  // 技能关联的负经验
  const negatives = (skill as SkillRecord & { linked_negative_exp?: string[] }).linked_negative_exp;
  if (negatives && negatives.length > 0) {
    lines.push(
      `⚠️ **Caveats**: This skill is associated with ${negatives.length} negative experience(s). ` +
        'Use with caution in contexts that differ from the original application.',
    );
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * 将单条 ExperienceRecord 格式化为 prompt 段落。
 *
 * 输出包含 experience_id（供 Driver 反馈引用）、置信度、描述、内容，
 * 以及关联的负经验 caveat。
 */
function formatExperienceSection(exp: ExperienceRecord): string {
  const lines: string[] = [];
  const confidencePercent = Math.round(exp.confidence * 100);

  lines.push(`### Experience [${exp.id}] (confidence: ${confidencePercent}%): ${exp.description}`);
  lines.push(`**Type**: ${exp.type} | **Tags**: ${exp.tags.join(', ')}`);
  if (exp.assumptions && exp.assumptions.length > 0) {
    lines.push(`**Assumptions**: ${exp.assumptions.join('; ')}`);
  }
  lines.push('');
  lines.push(exp.content);
  lines.push('');

  // 关联负经验
  const negatives = exp.linked_negative_exp;
  if (negatives && negatives.length > 0) {
    lines.push(
      `⚠️ **Linked caveats**: This experience has ${negatives.length} associated negative experience(s). ` +
        'The approach may fail under conditions documented in those records.',
    );
    lines.push('');
  }

  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════
// 默认结果映射器：DriverRunResult → DriverReturn
// ═══════════════════════════════════════════════════════════════

/**
 * 从 DriverRunResult 的 String 化 note 中提取摘要文本。
 *
 * 合并 diagnostics.notes 和 tool_events 中的 summary。
 */
function buildSummaryFromRunResult(result: DriverRunResult): string {
  const parts: string[] = [];

  // 执行状态
  parts.push(`Task completed with status: ${result.status}.`);

  // diagnostics 备注
  for (const note of result.diagnostics.notes) {
    if (note && note.trim()) {
      parts.push(note.trim());
    }
  }

  // tool_events 中的有意义的 summary
  const toolSummaries = result.tool_events
    .filter((e) => e.summary && e.summary.trim())
    .map((e) => `[${e.tool_name}] ${e.summary}`);
  if (toolSummaries.length > 0) {
    parts.push(`Tool operations: ${toolSummaries.join('; ')}`);
  }

  // 制品信息
  if (result.artifacts.length > 0) {
    const artifactDescs = result.artifacts
      .slice(0, 5)
      .map(
        (a) =>
          `${a.type}${
            a.metadata && typeof a.metadata === 'object' && 'summary' in a.metadata
              ? `: ${String((a.metadata as Record<string, unknown>).summary)}`
              : ''
          }`,
      );
    parts.push(`Produced ${result.artifacts.length} artifact(s): ${artifactDescs.join(', ')}`);
  }

  // 错误信息
  if (result.error) {
    parts.push(`Error encountered: [${result.error.code}] ${result.error.message}`);
  }

  return parts.join(' ');
}

/**
 * 从 tool_events 推断决策记录。
 *
 * 启发式规则：
 * - status 为 completed/failed 的事件视为关键操作点
 * - 每个事件构造一条 decision 记录：tool_name 作为决策点，status 作为选择结果
 * - 限制最多取前 5 条以避免膨胀
 */
function inferDecisionsFromToolEvents(result: DriverRunResult): DriverReturn['decisions'] {
  return result.tool_events
    .filter((e) => e.status === 'completed' || e.status === 'failed')
    .slice(0, 5)
    .map((e) => ({
      point: `Driver invoked tool: ${e.tool_name}`,
      options: ['execute', 'skip'],
      chosen: e.status === 'completed' ? 'execute' : 'execute (failed)',
      reason: e.summary || `Tool ${e.tool_name} was called during task execution.`,
    }));
}

/**
 * 从 tool_events 和 error 提取阻塞项。
 *
 * - status 为 failed 的 tool_events → 视为一个 blocker
 * - result.error（如果存在）→ 视为整体层面的 blocker
 */
function inferBlockersFromRunResult(result: DriverRunResult): DriverReturn['blockers'] {
  const blockers: DriverReturn['blockers'] = [];

  for (const event of result.tool_events) {
    if (event.status === 'failed') {
      blockers.push({
        blocker: `Tool "${event.tool_name}" failed`,
        attempts: [event.summary || 'No details available'],
        resolution: 'Not resolved — see diagnostics for full error context',
        resolved: false,
      });
    }
  }

  if (result.error && result.tool_events.every((e) => e.status !== 'failed')) {
    blockers.push({
      blocker: `Driver error: ${result.error.code}`,
      attempts: [result.error.message],
      resolution: result.error.retryable
        ? 'Retryable — may succeed on subsequent attempt'
        : 'Non-retryable — manual intervention may be required',
      resolved: false,
    });
  }

  return blockers;
}

/**
 * 构建引用经验的反馈列表。
 *
 * 默认所有经验标记为 applied: true, effectiveness: "not_applicable"——
 * 因为 Driver 的原始输出（DriverRunResult）不包含对每条经验的有效性评估。
 * 只有当 Driver 通过 memory_report 字段显式返回时才可获得真实评估。
 *
 * @param input - 含 driver_context.experiences[] 列表
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

/**
 * 从 task_instruction 中推断基本假设。
 *
 * 简单启发式：如果 instruction 中包含"假设"、"前提"、"Assume"、"Given" 等关键词，
 * 提取相关语句作为 assumption。这是粗粒度的推断——Driver 原生支持时应该由 Driver 报告。
 */
function inferAssumptions(taskInstruction: string): DriverReturn['assumptions'] {
  const assumptions: DriverReturn['assumptions'] = [];

  // 整个 task_instruction 本身就是一个隐含假设：
  // "Driver 收到正确的、上下文充分的 instruction"
  assumptions.push({
    assumption: 'Driver received complete and correct task instruction',
    risk_if_wrong:
      'The Driver may have executed based on incomplete or misdirected instructions, ' +
      'leading to irrelevant or incorrect output.',
  });

  // 此外，查找 instruction 中的显式假设标记
  const assumptionPatterns = [
    /假设[：:]\s*(.+?)(?=。|$)/g,
    /前提[：:]\s*(.+?)(?=。|$)/g,
    /Assume[：:]\s*(.+?)(?=\.(?:\s|$)|$)/gi,
    /Given\s+(.+?),/gi,
  ];

  for (const pattern of assumptionPatterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(taskInstruction)) !== null) {
      const assumptionText = match[1]?.trim();
      if (assumptionText && assumptionText.length > 0) {
        assumptions.push({
          assumption: assumptionText,
          risk_if_wrong: `If "${assumptionText}" is incorrect, the Driver's approach may be invalid.`,
        });
      }
    }
  }

  return assumptions;
}

/**
 * 默认的 DriverRunResult → DriverReturn 映射器。
 *
 * ## 映射规则
 *
 * | DriverReturn 字段 | 映射来源 |
 * |---|---|
 * | artifacts         | DriverRunResult.artifacts → type/path(uri)/summary |
 * | summary           | diagnostics.notes + tool_events.summary 聚合 |
 * | decisions         | tool_events 中 completed/failed 事件作为决策点 |
 * | blockers          | failed tool_events + result.error |
 * | referenced_exps   | input.driver_context.experiences（默认 not_applicable） |
 * | assumptions       | task_instruction 中推断 + 基本假设 |
 *
 * ## 精度限制
 *
 * 此默认映射器是**启发式**的，不保证 decisions/blockers/assumptions 的完整性和准确性。
 * 要提高精度，有两种路径：
 * 1. 让 Driver CLI 在 DriverRunResult 中附带 memory_report 字段（见设计文档 §5.5）
 * 2. 替换为自定义 mapResult 实现（如调用 LLM 从 transcript 中提取 6 字段报告）
 *
 * @param result - 方向A Driver 返回的通用执行结果
 * @param input  - 原始 DriverInvokeInput（用于获取 driver_context）
 * @returns 方向B 所需的 6 字段 DriverReturn
 */
export function mapRunResultToDriverReturn(
  result: DriverRunResult,
  input: DriverInvokeInput,
): DriverReturn {
  // artifacts: 从 ArtifactRef[] 提取
  const artifacts: DriverReturn['artifacts'] = result.artifacts.map((a: ArtifactRef) => ({
    type: a.type,
    path: a.uri,
    summary:
      a.metadata && typeof a.metadata === 'object' && 'summary' in a.metadata
        ? String((a.metadata as Record<string, unknown>).summary)
        : `${a.type} artifact produced by ${a.producer_id}`,
  }));

  // summary: 聚合执行摘要
  const summary = buildSummaryFromRunResult(result);

  // decisions: 从 tool_events 推断
  const decisions = inferDecisionsFromToolEvents(result);

  // blockers: 从失败事件和错误提取
  const blockers = inferBlockersFromRunResult(result);

  // referenced_experiences: 注入 driver_context.experiences 的 ID 列表
  const referencedExperiences = buildReferencedExperiences(input);

  // assumptions: 从 task_instruction 推断 + 基本假设
  const assumptions = inferAssumptions(input.driver_context.task_instruction);

  return {
    artifacts,
    summary,
    decisions,
    blockers,
    referenced_experiences: referencedExperiences,
    assumptions,
  };
}

// ═══════════════════════════════════════════════════════════════
// DriverAdapter 主类
// ═══════════════════════════════════════════════════════════════

/**
 * DriverAdapter —— 将方向A的 DriverRuntimeHandle 适配为方向B的 invokeDriver。
 *
 * ## 使用方式
 *
 * ```typescript
 * import { ExternalDriverRuntime, CommandDriverTransport } from '../driver';
 * import { DriverAdapter } from '../memory/adapters/driver-adapter';
 *
 * const transport = new CommandDriverTransport({
 *   command: 'gemini', args: ['acp'], timeoutMs: 120_000,
 * });
 * const runtime = new ExternalDriverRuntime({
 *   driver_id: 'gemini-cli-1', transport,
 * });
 * const adapter = new DriverAdapter({ driverRuntime: runtime });
 *
 * // 替换默认 MVP 依赖中的 mock Driver
 * const deps: AgentRunDeps = {
 *   ...defaultMvpAgentRunDeps,
 *   invokeDriver: (input) => adapter.invoke(input),
 * };
 * ```
 *
 * ## 错误传播
 *
 * `invoke()` 不捕获 `sendPrompt` 抛出的异常——所有认证失败、超时、
 * 传输错误直接向上传播给 memory-cycle。如需错误降级策略，
 * 在自定义 `mapResult` 或上层调用者中处理。
 */
export class DriverAdapter {
  private readonly driverRuntime: DriverRuntimeHandle;
  private readonly serializeContext: DriverContextSerializer;
  private readonly mapResult: DriverResultMapper;

  constructor(options: DriverAdapterOptions) {
    this.driverRuntime = options.driverRuntime;
    this.serializeContext = options.serializeContext ?? serializeDriverContext;
    this.mapResult = options.mapResult ?? mapRunResultToDriverReturn;
  }

  /**
   * 获取底层 DriverRuntimeHandle（用于查询 capabilities、interrupt 等）。
   *
   * 仅应在调试/监控场景使用；正常任务执行通过 invoke() 完成。
   */
  get runtime(): DriverRuntimeHandle {
    return this.driverRuntime;
  }

  /**
   * 执行一次 Driver 调用：序列化上下文 → 下发 prompt → 映射结果。
   *
   * 这是 AgentRunDeps.invokeDriver 的标准实现签名。
   *
   * @param input - 含 task_id、call_id、source_driver 与结构化 driver_context
   * @returns 6 字段 DriverReturn，供 memory-cycle 写入 buffer 和提取经验
   */
  async invoke(input: DriverInvokeInput): Promise<DriverReturn> {
    // 1. 序列化：DriverContext → prompt 字符串
    const prompt = this.serializeContext(input.driver_context, input);

    // 2. 构造方向A DriverPrompt 并下发
    const runId = createId('run');
    const result = await this.driverRuntime.sendPrompt({
      task_id: input.task_id,
      run_id: runId,
      prompt,
      created_at: nowTimestamp(),
      schema_version: SCHEMA_VERSION,
    });

    // 3. 映射：DriverRunResult → DriverReturn
    const driverReturn = await Promise.resolve(this.mapResult(result, input));

    return driverReturn;
  }
}

/**
 * 工厂函数：创建符合 AgentRunDeps.invokeDriver 签名的函数。
 *
 * 等价于 `new DriverAdapter(options).invoke`，但以函数形式暴露，便于直接赋值：
 *
 * ```typescript
 * const deps = {
 *   ...defaultMvpAgentRunDeps,
 *   invokeDriver: createDriverInvoker({ driverRuntime }),
 * };
 * ```
 */
export function createDriverInvoker(
  options: DriverAdapterOptions,
): (input: DriverInvokeInput) => Promise<DriverReturn> {
  const adapter = new DriverAdapter(options);
  return (input) => adapter.invoke(input);
}
