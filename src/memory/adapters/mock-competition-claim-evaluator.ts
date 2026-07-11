/**
 * MockCompetitionClaimEvaluator — CompetitionClaimEvaluator 的确定型 Mock
 *
 * 匹配规则：
 * - task.spec 包含关键词 "error" → 抛出异常
 * - task.spec 包含关键词 "irrelevant" / "不匹配" / "不适合" → 返回 decline
 * - task.spec 包含关键词 "relevant" / "qualified" / "适合" → 返回 participate
 * - 默认 → decline（保守策略）
 *
 * 当前只做简单的"参选/不参选"判断，详细竞标信息（置信度、证据链）
 * 待与 bid 模块对齐后补充。
 */
import type { CompetitionClaimEvaluator } from '../ports/competition-claim-evaluator';

/**
 * 创建确定型 Mock CompetitionClaimEvaluator。
 *
 * @param defaultDecision 当 spec 不匹配任何关键词时的默认决策（默认 'decline'）
 */
export function createMockCompetitionClaimEvaluator(
  defaultDecision: 'participate' | 'decline' = 'decline',
): CompetitionClaimEvaluator {
  return {
    async evaluate(input) {
      const spec = input.task.spec.toLowerCase();

      // 模拟 LLM 错误
      if (spec.includes('error')) {
        throw new Error('Mock evaluator: simulated LLM error');
      }

      // 匹配关键词 —— 注意：irrelevant 必须在 relevant 之前检查，因为前者包含后者作为子串
      if (spec.includes('irrelevant') || spec.includes('不匹配') || spec.includes('不适合')) {
        return { decision: 'decline' };
      }

      if (spec.includes('relevant') || spec.includes('qualified') || spec.includes('适合')) {
        return { decision: 'participate' };
      }

      // 默认决策
      return { decision: defaultDecision };
    },
  };
}
