/**
 * Competition Claim 类型定义
 *
 * 定义 Agent 参选声明的完整类型体系：声明决策、声明内容、批量收集结果。
 *
 * ## 职责边界
 *
 * - confidence 表达 Agent 对自身适配程度的判断，不是全局竞标分数。
 * - Memory 不根据 confidence 排名、不选赢家。
 * - Evidence 只返回引用和必要摘要，避免把完整记忆批量暴露给上层。
 */
import type { AgentStatus } from './schemas';
import type { AgentLoopState } from './agent-types';
import type { AgentTaskRequest } from './agent-types';

// ═══════════════════════════════════════════
// 声明决策
// ═══════════════════════════════════════════

/**
 * Agent 对一次任务机会的参选决策。
 *
 * - participate  : Agent 认为自己适配并主动参选
 * - decline      : Agent 认为自己不适配，明确拒绝
 * - unavailable  : 状态不可用（running/draining/retired），不调用 LLM
 * - timeout      : 在超时时间内未返回结果
 * - error        : 评估过程发生异常
 */
export type CompetitionDecision = 'participate' | 'decline' | 'unavailable' | 'timeout' | 'error';

// ═══════════════════════════════════════════
// 声明内容
// ═══════════════════════════════════════════

/**
 * evaluator 返回的声明核心内容（不含 role_id 等元数据）。
 *
 * 由 CompetitionClaimEvaluator.evaluate() 产出，Agent.createCompetitionClaim()
 * 包装为完整声明。
 */
export interface AgentCompetitionClaimContent {
  decision: CompetitionDecision;
  confidence: number | null;
  rationale: string;
  evidence: {
    persona_version: number;
    persona_summary: string;
    skill_ids: string[];
    experience_ids: string[];
  };
  risks: string[];
}

/**
 * 单个 Agent 的完整参选声明。
 *
 * 由 Agent.createCompetitionClaim() 组装返回。
 */
export interface AgentCompetitionClaim {
  role_id: string;
  decision: CompetitionDecision;
  confidence: number | null;
  rationale: string;
  evidence: {
    persona_version: number;
    persona_summary: string;
    skill_ids: string[];
    experience_ids: string[];
  };
  risks: string[];
  availability: {
    agent_status: AgentStatus;
    loop_state: AgentLoopState;
  };
  generated_at: string;
}

/**
 * 批量声明收集结果。
 *
 * 由 collectCompetitionClaims() 返回：
 * - 包含所有 Agent 的结果（包括拒绝、不可用、超时、错误）
 * - 按 role_id 排序，不依赖异步完成顺序
 * - 保留 correlation_id，方便未来升级为异步事件模式
 */
export interface CompetitionClaimBatch {
  correlation_id: string;
  task_id: string;
  claims: AgentCompetitionClaim[];
  started_at: string;
  completed_at: string;
}

/**
 * collectCompetitionClaims 的选项参数。
 */
export interface CollectCompetitionClaimsOptions {
  /** 单次收集超时，默认 10_000ms */
  timeout_ms?: number;
}

/**
 * 根据 AgentTaskRequest 构建竞争查询所需的上下文输入。
 */
export interface CompetitionQueryInput {
  task: AgentTaskRequest;
}
