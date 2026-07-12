/**
 * CompetitionClaimEvaluator 端口
 *
 * 定义 Agent 参选判断的注入契约：Agent 根据任务信息自主决定是否参选。
 * 当前只做简单的"参选/不参选"判断，详细竞标信息（置信度、证据链）
 * 待与 bid 模块对齐后补充。
 */
import type { AgentTaskRequest } from '../agent-types';
import type { AgentCompetitionClaimContent } from '../competition-types';

export interface CompetitionClaimEvaluator {
  /**
   * 评估 Agent 是否参选本次任务机会。
   *
   * @param input.task - 协调层下发的任务机会
   * @returns Agent 参选判断（当前只含 decision，详细字段待 bid 模块对齐）
   */
  evaluate(input: { task: AgentTaskRequest }): Promise<AgentCompetitionClaimContent>;
}
