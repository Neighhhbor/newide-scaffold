/**
 * SkillPromotionProcessor — 技能晋升处理器
 *
 * 扫描 Agent 已保存的未晋升经验，检查 eligibility 后晋升为 Skill。
 * 不依赖 buffer；仅基于已有的 ExperienceRecord。
 *
 * 两种调用模式：
 *   - promoteAll()      : 手动模式，晋升所有符合条件的经验
 *   - checkAndPromote() : 自动模式，先评估 PromotionTriggerPolicy，满足条件再晋升
 */
import { randomUUID } from 'node:crypto';
import type { AgentMemoryScope } from '../ports/agent-memory-scope';
import type { PromotionTriggerPolicy } from '../ports/promotion-trigger-policy';
import type { ExperienceRecord } from '../schemas';
import type { AgentTaskRequest } from '../agent-types';
import type { PromotionOutcome } from '../types';

export type SkillPromotionHandler = (
  memory: AgentMemoryScope,
  task: AgentTaskRequest,
  experiences: ExperienceRecord[],
) => Promise<PromotionOutcome>;

export interface SkillPromotionPlan {
  experience_ids: string[];
}

/** 晋升置信度门槛（与 ruleBasedSkillPromotion 一致） */
const PROMOTION_CONFIDENCE_THRESHOLD = 0.95;
/** 高置信度门槛（用于 PromotionTriggerPolicy 的 has_high_confidence 判断） */
const HIGH_CONFIDENCE_THRESHOLD = 0.98;

export class SkillPromotionProcessor {
  constructor(
    private readonly policy: PromotionTriggerPolicy,
    private readonly promote: SkillPromotionHandler,
  ) {}

  /**
   * 手动模式：晋升所有符合条件的经验。
   *
   * 筛选条件（与 Spec §4.3 一致）：
   *   - type === 'positive'
   *   - confidence > 0.95
   *   - promoted_to === undefined
   */
  async promoteAll(memory: AgentMemoryScope): Promise<PromotionOutcome[]> {
    const eligible = await this.findEligibleExperiences(memory);
    if (eligible.length === 0) {
      return [];
    }

    const results: PromotionOutcome[] = [];
    for (const experience of eligible) {
      const outcome = await this.promoteOne(memory, experience);
      results.push(outcome);
    }

    return results;
  }

  /**
   * 自动模式：先评估 PromotionTriggerPolicy，满足条件才晋升。
   *
   * @returns 晋升结果列表；未触发时返回空数组
   */
  async checkAndPromote(memory: AgentMemoryScope): Promise<PromotionOutcome[]> {
    const plan = await this.planPromotions(memory);
    return this.executePromotionPlan(memory, plan);
  }

  async planPromotions(memory: AgentMemoryScope): Promise<SkillPromotionPlan> {
    const allExperiences = await memory.listExperiences();
    return this.planEligiblePromotions(memory, this.filterEligible(allExperiences));
  }

  async executePromotionPlan(
    memory: AgentMemoryScope,
    plan: SkillPromotionPlan,
    shouldContinue?: () => boolean,
  ): Promise<PromotionOutcome[]> {
    const byId = new Map(
      (await memory.listExperiences()).map((experience) => [experience.id, experience]),
    );
    const results: PromotionOutcome[] = [];
    for (const experienceId of plan.experience_ids) {
      if (shouldContinue?.() === false) {
        throw new Error('Skill promotion stopped at a maintenance boundary');
      }
      const experience = byId.get(experienceId);
      if (!experience) {
        throw new Error(`Promotion plan Experience not found: ${experienceId}`);
      }
      const outcome = await this.promoteOne(memory, experience);
      if (shouldContinue?.() === false) {
        throw new Error('Skill promotion stopped at a maintenance boundary');
      }
      if (!outcome.skill) {
        throw new Error(`Promotion plan did not produce a Skill: ${experienceId}`);
      }
      results.push(outcome);
    }

    return results;
  }

  private async planEligiblePromotions(
    memory: AgentMemoryScope,
    eligible: ExperienceRecord[],
  ): Promise<SkillPromotionPlan> {
    if (eligible.length === 0) {
      return { experience_ids: [] };
    }

    const hasHighConfidence = eligible.some((e) => e.confidence > HIGH_CONFIDENCE_THRESHOLD);
    const lastPromotionAt = await this.getLastPromotionAt(memory);

    if (
      !this.policy.shouldPromote({
        role_id: memory.role_id,
        eligible_count: eligible.length,
        has_high_confidence: hasHighConfidence,
        last_promotion_at: lastPromotionAt,
      })
    ) {
      return { experience_ids: [] };
    }

    return { experience_ids: eligible.map((experience) => experience.id).sort() };
  }

  /**
   * 晋升单条经验：调用 promote handler → saveSkill → updateExperience。
   */
  private async promoteOne(
    memory: AgentMemoryScope,
    experience: ExperienceRecord,
  ): Promise<PromotionOutcome> {
    const existingSkill = (await memory.listSkills()).find(
      (skill) => skill.promoted_from === experience.id,
    );
    if (existingSkill) {
      assertPendingPromotion(memory.role_id, {
        check: {
          eligible: true,
          auto_approved: false,
          reasons: ['Recovered existing pending Skill promotion'],
          blocking_rules: [],
        },
        skill: existingSkill,
      });
      if (experience.promoted_to !== existingSkill.id) {
        await memory.updateExperience({ ...experience, promoted_to: existingSkill.id });
      }
      return {
        check: {
          eligible: true,
          auto_approved: false,
          reasons: ['Recovered existing pending Skill promotion'],
          blocking_rules: [],
        },
        skill: existingSkill,
      };
    }

    if (experience.promoted_to) {
      throw new Error(
        `Experience points to a missing promoted Skill: ${experience.id}:${experience.promoted_to}`,
      );
    }

    const dummyTask = {
      spec: 'skill-promotion',
      task_id: `promotion-${randomUUID()}`,
      call_id: `promotion-${randomUUID()}`,
      source_driver: 'promotion-processor',
    };

    const outcome = await this.promote(memory, dummyTask, [experience]);
    assertPendingPromotion(memory.role_id, outcome);
    return outcome;
  }

  /**
   * 查找所有符合条件的经验（未晋升、正经验、高置信度）。
   */
  private async findEligibleExperiences(memory: AgentMemoryScope): Promise<ExperienceRecord[]> {
    const all = await memory.listExperiences();
    return this.filterEligible(all);
  }

  private filterEligible(experiences: ExperienceRecord[]): ExperienceRecord[] {
    return experiences.filter(
      (e) =>
        e.type === 'positive' &&
        e.confidence > PROMOTION_CONFIDENCE_THRESHOLD &&
        e.promoted_to === undefined,
    );
  }

  /**
   * 获取最近一次晋升时间（从已有技能的 promoted_at 中取最大值）。
   */
  private async getLastPromotionAt(memory: AgentMemoryScope): Promise<Date | null> {
    const skills = await memory.listSkills();
    if (skills.length === 0) {
      return null;
    }

    const latest = skills.reduce<Date | null>((latest, skill) => {
      const promotedAt = new Date(skill.promoted_at);
      return latest === null || promotedAt > latest ? promotedAt : latest;
    }, null);

    return latest;
  }
}

function assertPendingPromotion(roleId: string, outcome: PromotionOutcome): void {
  if (outcome.check.auto_approved) {
    throw new Error('Skill promotion must not be auto-approved');
  }
  if (!outcome.skill) return;
  if (outcome.skill.review_status !== 'pending') {
    throw new Error(`Promoted Skill must remain pending: ${outcome.skill.id}`);
  }
  if (outcome.skill.agent_id !== roleId) {
    throw new Error(`Promoted Skill belongs to the wrong Agent: ${outcome.skill.id}`);
  }
}
