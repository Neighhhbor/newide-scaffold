/**
 * AgentCompetitionQuery 端口
 *
 * 定义竞争声明查询的契约：Memory 通过此端口收集所有 Agent 对一次任务机会的参选声明。
 *
 * ## 职责边界
 *
 * - Memory 只是收集器，不是竞标决策器
 * - 不排序、不过滤参选者、不计算赢家
 * - 返回所有 Agent 的结果，包括拒绝、不可用、超时和错误
 * - 保留 correlation_id，方便未来升级为异步事件模式
 */
import type { AgentTaskRequest } from '../agent-types';
import type { CompetitionClaimBatch, CollectCompetitionClaimsOptions } from '../competition-types';

export interface AgentCompetitionQuery {
  /**
   * 收集所有 Agent 对一次任务机会的参选声明。
   *
   * - 同步批量收集，但保留 correlation_id 支持未来异步升级
   * - 所有可用 Agent 并行生成声明
   * - 超时 Agent 返回 timeout，不阻塞其他结果
   * - 单个 Agent 的失败不影响整个批次
   * - 收集声明不会占用任务槽、不会改变 Agent 为 running
   *
   * @param task    - 协调层下发的任务机会
   * @param options - 可选超时等控制参数
   */
  collectCompetitionClaims(
    task: AgentTaskRequest,
    options?: CollectCompetitionClaimsOptions,
  ): Promise<CompetitionClaimBatch>;
}
