/**
 * CompetitionClaimEvaluator 端口
 *
 * 定义 Agent 参选判断的注入契约：Agent 根据任务、Persona、相关经验和技能，
 * 自主决定是否参选并输出证据化声明。
 *
 * 生产实现使用 LLM；测试提供确定性 Mock。
 */
import type { AgentTaskRequest } from '../agent-types';
import type { AgentCompetitionClaimContent } from '../competition-types';
import type { PersonaDef, SkillRecord, ExperienceRecord } from '../schemas';

export interface CompetitionClaimEvaluator {
  /**
   * 评估 Agent 对一次任务机会的适配程度。
   *
   * @param input.task            - 协调层下发的任务机会
   * @param input.persona         - Agent 当前 Persona 快照
   * @param input.relevant_skills  - 与任务相关的技能列表（Agent 自行判断相关度）
   * @param input.relevant_experiences - 与任务相关的经验列表
   * @returns Agent 参选声明内容（不含 role_id 等元数据）
   */
  evaluate(input: {
    task: AgentTaskRequest;
    persona: PersonaDef;
    relevant_skills: SkillRecord[];
    relevant_experiences: ExperienceRecord[];
  }): Promise<AgentCompetitionClaimContent>;
}
