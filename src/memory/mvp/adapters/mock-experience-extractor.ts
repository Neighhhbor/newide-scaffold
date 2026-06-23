/**
 * MockExperienceExtractor — ExperienceExtractor 的 MVP 实现
 *
 * 从 BufferSnapshot + AgentContextSnapshot 规则生成一条固定结构的 ExperienceRecord。
 */
import { randomUUID } from "node:crypto";
import { nowTimestamp } from "../../../core";
import type { ExperienceExtractor } from "../../ports/experience-extractor";
import type { AgentContextSnapshot, BufferSnapshot } from "../../schemas";
import type { ExtractionOutput } from "../../types";

export class MockExperienceExtractor implements ExperienceExtractor {
  async extract(
    snapshot: BufferSnapshot,
    agentContext?: AgentContextSnapshot,
  ): Promise<ExtractionOutput> {
    const now = nowTimestamp();
    const thinking = agentContext?.thinking_trace ?? "pass: no agent context snapshot";

    const experience = {
      id: randomUUID(),
      description: `Learned from task ${snapshot.task_id}: ${snapshot.driver_return.summary}`,
      description_embedding: [0.1, 0.2, 0.3],
      content: [
        `Task: ${snapshot.task_description}`,
        `Driver summary: ${snapshot.driver_return.summary}`,
        `Agent context: ${thinking}`,
      ].join("\n"),
      confidence: 0.75,
      tags: ["mvp", "mock-extraction"],
      agent_id: agentContext?.agent_id ?? snapshot.source_task_id,
      confidence_history: [
        { value: 0.75, updated_at: now, reason: "MVP mock initial extraction" },
      ],
      referenced_count: 0,
      source_task_id: snapshot.source_task_id,
      source_driver: snapshot.source_driver,
      type: "positive" as const,
      created_at: now,
      updated_at: now,
    };

    return {
      experiences: [experience],
      result: {
        experiences_created: 1,
        experiences_updated: 0,
        negative_experiences: 0,
        skills_promoted: 0,
      },
    };
  }
}
