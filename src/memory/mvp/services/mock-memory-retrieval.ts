/**
 * Mock 记忆检索策略（MemoryQueryStrategy）
 *
 * 固定 memory_refs + 从 AgentMemoryScope 读取 Persona/Skills/Experiences，装配 ContextPack。
 * pass：无语义/向量检索。可整包删除后替换为真实检索实现。
 */
import { SCHEMA_VERSION } from "../../../core";
import type { MemoryRef } from "../../../core";
import type { ContextPack } from "../../contract";
import type { AgentMemoryScope } from "../../ports/agent-memory-scope";
import type { AgentTaskRequest } from "../../agent-types";
import type { MemoryRetrievalResult } from "../../services/memory-query";

const FIXED_MEMORY_REFS: MemoryRef[] = [
  {
    memory_id: "memory_mock_contract",
    kind: "experience",
    uri: "memory://mock/contract-boundaries",
    summary: "Keep v0 contracts stable while mocks stay simple.",
    schema_version: SCHEMA_VERSION,
  },
];

export async function mockRetrieveMemoryForTask(
  memory: AgentMemoryScope,
  task: AgentTaskRequest,
  task_id: string,
): Promise<MemoryRetrievalResult> {
  void task;

  const persona = await memory.getPersona();
  const skills = await memory.listSkills();
  const experiences = await memory.listExperiences();

  const context_pack: ContextPack = {
    context_pack_id: `context_pack_${task_id}`,
    task_id,
    role_profile_ref: {
      role_id: memory.role_id,
      persona_ref: `persona://${memory.role_id}/current`,
      skill_refs: skills.map((s) => `skill://${s.id}`),
      capability_tags: ["typescript", "mock"],
      memory_policy: {
        allow_in_driver_context: true,
        allow_in_council_proposer: true,
        allow_in_council_judge: true,
        max_memory_items: 5,
      },
      schema_version: SCHEMA_VERSION,
    },
    memory_refs: FIXED_MEMORY_REFS,
    artifact_refs: [],
    summary: `[mock retrieval] persona v${persona.version}; ${experiences.length} exps; ${skills.length} skills`,
    created_at: new Date().toISOString(),
    schema_version: SCHEMA_VERSION,
  };

  return { persona, skills, experiences, context_pack };
}
