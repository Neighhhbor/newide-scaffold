/**
 * Competition Claim 类型定义
 *
 * 定义 Agent 参选声明的完整类型体系：声明决策、声明内容、批量收集结果。
 *
 * ## 职责边界
 *
 * - Memory 只负责收集声明，不作排名、不选赢家。
 * - AgentCompetitionClaimContent 只表达"是否参选"的自我判断，
 *   详细竞标信息（置信度、证据链）待与 bid 模块对齐后补充。
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
 * - unavailable  : 状态不可用（draining/retired/stopped），不调用 LLM
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
 * 当前只表达"是否参选"的自我判断，详细竞标信息（置信度、证据链、风险分析）
 * 待与 bid 模块对齐后补充。
 */
export interface AgentCompetitionClaimContent {
  decision: CompetitionDecision;
  /** 占位：待 bid 模块对齐 */
  confidence?: number | null;
  /** 占位：待 bid 模块对齐 */
  rationale?: string;
}

/**
 * 单个 Agent 的完整参选声明。
 *
 * 由 Agent.createCompetitionClaim() 组装返回。
 * collectCompetitionClaims() 只返回 decision === 'participate' 的 Agent。
 * 上层所需能力信息（persona_summary / skill_count / 等）待后续补充。
 */
export interface AgentCompetitionClaim {
  role_id: string;
  decision: CompetitionDecision;
  /** 占位：待上层模块对齐 */
  confidence?: number | null;
  /** 占位：待上层模块对齐 */
  rationale?: string;
  availability: {
    agent_status: AgentStatus;
    loop_state: AgentLoopState;
    /** 标记 Agent 正在执行任务中（仍参与自评但不接受新派发） */
    busy?: boolean;
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
  /** 全景摘要，让上层快速判断"无人接 / 都在忙 / 有机会" */
  summary: {
    total: number;
    participated: number;
    busy_participated: number;
    declined: number;
    unavailable: number;
    timed_out: number;
    errored: number;
  };
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
