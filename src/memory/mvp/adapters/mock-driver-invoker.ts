/**
 * Mock Driver 调用器
 *
 * MVP 版 invokeDriver 实现：根据 DriverContext 生成 DriverReturn（6 字段报告）。
 *
 * ## 输入边界
 *
 * - 仅读取 driver_context（task_instruction + experiences + skills）
 * - 不读取 task.spec，不感知 Persona
 * - experiences/skills 为完整实体，真实 Driver 应使用其 content 组装 prompt
 */
import type { DriverReturn } from '../../schemas';
import type { DriverInvokeInput } from '../../runtime/agent-run-deps';

/**
 * 唤起 mock Driver 并返回 Spec 6 字段报告。
 *
 * @param input - 含 task_id、call_id、source_driver 与 driver_context
 * @returns Driver 6 字段结构化报告（artifacts / summary / decisions 等）
 */
export async function invokeMockDriver(input: DriverInvokeInput): Promise<DriverReturn> {
  const { task_id, driver_context } = input;
  const memoryCount = driver_context.experiences.length + driver_context.skills.length;

  return {
    artifacts: [
      {
        type: 'patch',
        path: `artifact://patch/${task_id}/mock.patch`,
        summary: `Mock patch for: ${driver_context.task_instruction}`,
      },
    ],
    summary: `Mock driver completed instruction using ${memoryCount} memory items (${driver_context.skills.length} skills, ${driver_context.experiences.length} experiences).`,
    decisions: [
      {
        point: 'context usage',
        options: ['use-retrieved-memory', 'ignore-memory'],
        chosen: 'use-retrieved-memory',
        reason: 'MVP always chooses retrieved memories',
      },
    ],
    blockers: [],
    referenced_experiences: driver_context.experiences.slice(0, 1).map((exp) => ({
      experience_id: exp.id,
      applied: true,
      effectiveness: 'fully_effective' as const,
      note: 'MVP mock reference',
    })),
    assumptions: [
      {
        assumption: driver_context.task_instruction,
        risk_if_wrong: 'Planned driver instruction may not match full task spec',
      },
    ],
  };
}
