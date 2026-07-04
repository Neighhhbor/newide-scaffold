import type { AgentProjection, TaskSpecification, ScoreBreakdownDetail } from './models';

/**
 * 评分引擎
 * 根据 RFC 中的评分公式计算最终分数
 */
export class ScoringEngine {
  /**
   * 计算代理与任务的相关性得分
   */
  calculateRelevance(agent: AgentProjection, task: TaskSpecification): number {
    // 0.40 * persona_match + 0.3 * skill_match + 0.3 * experience_match
    const personaMatch = this.calculatePersonaMatch(agent, task);
    const skillMatch = this.calculateSkillMatch(agent, task);
    const experienceMatch = this.calculateExperienceMatch(agent, task);

    return 0.4 * personaMatch + 0.3 * skillMatch + 0.3 * experienceMatch;
  }

  /**
   * 计算人设匹配度
   */
  private calculatePersonaMatch(agent: AgentProjection, task: TaskSpecification): number {
    const required = task.requirement_profile.persona_requirements;
    const agentPersona = agent.persona;

    const keys = Object.keys(required);
    if (keys.length === 0) return 0.5; // 无要求时返回中性值

    const scores = keys.map((key) => {
      const requiredLevel = required[key] ?? 0.5;
      const agentLevel = agentPersona[key] ?? 0.3;
      // 使用余弦相似度的近似
      return Math.min(1, agentLevel / (requiredLevel + 0.1));
    });

    return scores.reduce((a, b) => a + b) / scores.length;
  }

  /**
   * 计算技能匹配度
   */
  private calculateSkillMatch(agent: AgentProjection, task: TaskSpecification): number {
    const preferredTags = task.requirement_profile.role_hint.preferred_role_tags;
    const agentSkills = agent.skills;

    if (preferredTags.length === 0) return 0.5;

    let matchScore = 0;
    for (const tag of preferredTags) {
      const skill = agentSkills.find((s) => s.tags.includes(tag));
      if (skill) {
        matchScore += skill.confidence;
      }
    }

    return Math.min(1, matchScore / preferredTags.length);
  }

  /**
   * 计算经验匹配度
   */
  private calculateExperienceMatch(agent: AgentProjection, _task: TaskSpecification): number {
    const experiences = agent.experience;
    const positiveExp = experiences.filter((e) => e.type === 'positive');

    if (experiences.length === 0) return 0.5;

    const avgConfidence =
      positiveExp.length > 0
        ? positiveExp.reduce((sum, e) => sum + e.confidence, 0) / positiveExp.length
        : 0;

    return Math.min(1, avgConfidence);
  }

  /**
   * 计算质量得分
   */
  calculateQuality(agent: AgentProjection): number {
    // 0.5 * recent_success_rate + 0.3 * avg_confidence + 0.1 * experience_density + 0.1 * skill_density
    const recentSuccessRate = this.calculateRecentSuccessRate(agent);
    const avgConfidence = agent.metrics_ref.avg_confidence;
    const experienceDensity = this.calculateExperienceDensity(agent);
    const skillDensity = this.calculateSkillDensity(agent);

    return (
      0.5 * recentSuccessRate + 0.3 * avgConfidence + 0.1 * experienceDensity + 0.1 * skillDensity
    );
  }

  /**
   * 计算最近成功率
   */
  private calculateRecentSuccessRate(agent: AgentProjection): number {
    const { total_tasks, last_20_tasks_succeeded } = agent.metrics_ref;

    if (total_tasks < 3) return 0.5;

    const recentTasksCount = Math.min(20, total_tasks);
    return last_20_tasks_succeeded / recentTasksCount;
  }

  /**
   * 计算经验密度
   */
  private calculateExperienceDensity(agent: AgentProjection): number {
    const { total_tasks } = agent.metrics_ref;
    const { experience_count } = agent.metrics_ref;

    if (total_tasks === 0) return 0;
    return Math.min(1, experience_count / total_tasks);
  }

  /**
   * 计算技能密度
   */
  private calculateSkillDensity(agent: AgentProjection): number {
    const { experience_count, skill_count } = agent.metrics_ref;

    if (experience_count === 0) return 0;
    return Math.min(1, skill_count / experience_count);
  }

  /**
   * 计算容量得分
   */
  private calculateCapacity(agent: AgentProjection): number {
    // 1.0 - min(1.0, active_task_count / 3)
    const { active_task_count } = agent.load_state;
    return 1.0 - Math.min(1.0, active_task_count / 3);
  }

  /**
   * 计算新鲜度得分
   */
  private calculateFreshness(agent: AgentProjection): number {
    // 1.0 / (1.0 + days_since_last_task / 14)
    const { days_since_last_task } = agent.load_state;
    return 1.0 / (1.0 + days_since_last_task / 14);
  }

  /**
   * 计算新手保护加分
   */
  private calculateBonus(agent: AgentProjection): number {
    const { total_tasks } = agent.metrics_ref;
    return total_tasks < 5 ? 0.15 : 0.0;
  }

  /**
   * 计算最终得分和明细
   */
  public calculateScore(agent: AgentProjection, task: TaskSpecification): ScoreBreakdownDetail {
    const relevanceBreakdown = {
      persona_match: this.calculatePersonaMatch(agent, task),
      skill_match: this.calculateSkillMatch(agent, task),
      experience_match: this.calculateExperienceMatch(agent, task),
    };
    const relevance =
      0.4 * relevanceBreakdown.persona_match +
      0.3 * relevanceBreakdown.skill_match +
      0.3 * relevanceBreakdown.experience_match;

    const qualityBreakdown = {
      recent_success_rate: this.calculateRecentSuccessRate(agent),
      avg_confidence: agent.metrics_ref.avg_confidence,
      experience_density: this.calculateExperienceDensity(agent),
      skill_density: this.calculateSkillDensity(agent),
    };
    const quality =
      0.5 * qualityBreakdown.recent_success_rate +
      0.3 * qualityBreakdown.avg_confidence +
      0.1 * qualityBreakdown.experience_density +
      0.1 * qualityBreakdown.skill_density;

    const capacity = this.calculateCapacity(agent);
    const freshness = this.calculateFreshness(agent);
    const bonus = this.calculateBonus(agent);

    const finalScore = 0.4 * relevance + 0.3 * quality + 0.15 * capacity + 0.15 * freshness + bonus;

    return {
      relevance: Math.min(1, relevance),
      relevance_breakdown: relevanceBreakdown,
      quality: Math.min(1, quality),
      quality_breakdown: qualityBreakdown,
      capacity,
      freshness,
      bonus,
      final_score: Math.min(1, finalScore),
    };
  }
}
