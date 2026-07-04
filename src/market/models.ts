import { z } from 'zod';

/**
 * Agent 能力投影模型
 * Market 不直接访问 B-layer memory，只使用 projection
 */
export const AgentProjectionSchema = z.object({
  agent_id: z.string(),
  persona_ref: z.string(),
  persona: z.record(z.string(), z.number().min(0).max(1)),
  skills: z.array(
    z.object({
      name: z.string(),
      confidence: z.number().min(0).max(1),
      tags: z.array(z.string()),
    }),
  ),
  experience: z.array(
    z.object({
      name: z.string(),
      type: z.enum(['positive', 'negative']),
      confidence: z.number().min(0).max(1),
    }),
  ),
  metrics_ref: z.object({
    total_tasks: z.number().int().nonnegative(),
    last_20_tasks_succeeded: z.number().int().nonnegative(),
    skill_count: z.number().int().nonnegative(),
    experience_count: z.number().int().nonnegative(),
    avg_confidence: z.number().min(0).max(1),
  }),
  load_state: z.object({
    active_task_count: z.number().int().nonnegative(),
    days_since_last_task: z.number().nonnegative(),
  }),
});

export type AgentProjection = z.infer<typeof AgentProjectionSchema>;

/**
 * 任务规格模型
 */
export const TaskSpecificationSchema = z.object({
  task_id: z.string(),
  task_description: z.string(),
  requirement_profile: z.object({
    persona_requirements: z.record(z.string(), z.number().min(0).max(1)),
    domain_requirements: z.object({
      system_domain: z.string(),
      scale_level: z.number().min(0).max(1),
      risk_level: z.enum(['low', 'medium', 'high']),
    }),
    role_hint: z.object({
      preferred_role_tags: z.array(z.string()),
    }),
  }),
  context: z.object({
    urgency: z.number().min(0).max(1),
    exploration_level: z.number().min(0).max(1),
  }),
});

export type TaskSpecification = z.infer<typeof TaskSpecificationSchema>;

/**
 * 竞标记录模型
 */
export const BidSchema = z.object({
  bid_id: z.string(),
  task_id: z.string(),
  agent_id: z.string(),
  score_breakdown: z.object({
    skill_match: z.number().min(0).max(1),
    experience_match: z.number().min(0).max(1),
  }),
  final_score: z.number().min(0).max(1),
  estimated_time: z.number().int().positive(),
  strategy_summary: z.string(),
  timestamp: z.number(),
});

export type Bid = z.infer<typeof BidSchema>;

/**
 * 评分明细
 */
export const ScoreBreakdownDetailSchema = z.object({
  relevance: z.number().min(0).max(1),
  relevance_breakdown: z.object({
    persona_match: z.number().min(0).max(1),
    skill_match: z.number().min(0).max(1),
    experience_match: z.number().min(0).max(1),
  }),
  quality: z.number().min(0).max(1),
  quality_breakdown: z.object({
    recent_success_rate: z.number().min(0).max(1),
    avg_confidence: z.number().min(0).max(1),
    experience_density: z.number().min(0).max(1),
    skill_density: z.number().min(0).max(1),
  }),
  capacity: z.number().min(0).max(1),
  freshness: z.number().min(0).max(1),
  bonus: z.number(),
  final_score: z.number().min(0).max(1),
});

export type ScoreBreakdownDetail = z.infer<typeof ScoreBreakdownDetailSchema>;

/**
 * 审计产物模型
 */
export const AuditBundleSchema = z.object({
  task_id: z.string(),
  winner_bid: z.string(),
  all_bids: z.array(z.string()),
  selection_mode: z.string(),
  decision_explanation: z.object({
    primary_reason: z.string(),
    secondary_reason: z.string().optional(),
  }),
  owner_report: z.object({
    why_me: z.string(),
    risk_ack: z.string().optional(),
    coordination_plan: z.string().optional(),
  }),
  timestamp: z.number(),
});

export type AuditBundle = z.infer<typeof AuditBundleSchema>;

/**
 * 竞标日志
 */
export interface BidLedger {
  task_id: string;
  bids: Bid[];
  created_at: number;
  updated_at: number;
}
