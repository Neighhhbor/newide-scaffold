/**
 * Mock 技能晋升（SkillPromotionHandler）
 *
 * 按 AgentTaskRequest.scenario 分支：默认跳过、promotion_ready 晋升、promotion_blocked 阻止。
 */
import { randomUUID } from "node:crypto";
import { nowTimestamp } from "../../../core";
import type { AgentMemoryScope } from "../../ports/agent-memory-scope";
import type { ExperienceRecord } from "../../schemas";
import type { AgentTaskRequest } from "../../agent-types";
import type { PromotionOutcome } from "../../types";

export async function runMockSkillPromotion(
  memory: AgentMemoryScope,
  task: AgentTaskRequest,
  experiences: ExperienceRecord[],
): Promise<PromotionOutcome> {
  const primary = experiences[0];

  if (task.scenario === "promotion_blocked") {
    return {
      check: {
        eligible: false,
        auto_approved: false,
        reasons: [],
        blocking_rules: ["MVP mock: promotion_blocked scenario"],
      },
    };
  }

  if (task.scenario !== "promotion_ready" || !primary) {
    return {
      check: {
        eligible: false,
        auto_approved: false,
        reasons: [],
        blocking_rules: ["MVP mock: default scenario skips promotion"],
      },
    };
  }

  const now = nowTimestamp();
  const skill = {
    id: randomUUID(),
    description: `Promoted skill from ${primary.source_task_id}`,
    description_embedding: [0.4, 0.5, 0.6],
    content: primary.content,
    version: "1.0.0",
    review_status: "approved" as const,
    tags: ["mvp", "promoted"],
    promoted_from: primary.id,
    promoted_at: now,
    agent_id: memory.role_id,
    market_status: "available" as const,
    created_at: now,
    updated_at: now,
  };

  await memory.saveSkill(skill);
  await memory.updateExperience({ ...primary, promoted_to: skill.id });

  return {
    check: {
      eligible: true,
      auto_approved: true,
      reasons: ["MVP mock: promotion_ready scenario"],
      blocking_rules: [],
    },
    skill,
  };
}
