/**
 * MockCompetitionClaimEvaluator — CompetitionClaimEvaluator 的确定型 Mock
 *
 * 匹配规则：
 * - task.spec 包含关键词 "relevant" → participate（置信度 0.85）
 * - task.spec 包含关键词 "irrelevant" → decline
 * - task.spec 包含关键词 "error" → 抛出异常
 * - 默认 → decline（保守策略）
 *
 * 供测试使用，不调用 LLM。
 */
import type { CompetitionClaimEvaluator } from '../ports/competition-claim-evaluator';
import type { AgentCompetitionClaimContent } from '../competition-types';

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
        return createDeclineClaim(input);
      }

      if (spec.includes('relevant') || spec.includes('qualified') || spec.includes('适合')) {
        return createParticipateClaim(input);
      }

      // 默认决策
      if (defaultDecision === 'participate') {
        return createParticipateClaim(input);
      }
      return createDeclineClaim(input);
    },
  };
}

function createParticipateClaim(input: {
  persona: { version: number; summary: string };
  relevant_skills: Array<{ id: string }>;
  relevant_experiences: Array<{ id: string }>;
}): AgentCompetitionClaimContent {
  return {
    decision: 'participate',
    confidence: 0.85,
    rationale: 'Task matches my skill set and past experience.',
    evidence: {
      persona_version: input.persona.version,
      persona_summary: input.persona.summary,
      skill_ids: input.relevant_skills.map((s) => s.id),
      experience_ids: input.relevant_experiences.map((e) => e.id),
    },
    risks: [],
  };
}

function createDeclineClaim(input: {
  persona: { version: number; summary: string };
  relevant_skills: Array<{ id: string }>;
  relevant_experiences: Array<{ id: string }>;
}): AgentCompetitionClaimContent {
  return {
    decision: 'decline',
    confidence: null,
    rationale: 'Task does not match my expertise or current focus.',
    evidence: {
      persona_version: input.persona.version,
      persona_summary: input.persona.summary,
      skill_ids: input.relevant_skills.map((s) => s.id),
      experience_ids: input.relevant_experiences.map((e) => e.id),
    },
    risks: ['Potential skill mismatch may lead to poor quality.'],
  };
}
