/**
 * AgentMemoryScope 适配器
 *
 * 将 MemoryRepository 包装为绑定 role_id 的作用域对象；
 * 由 AgentManager.createAgent 为每个 Agent 创建独立实例。
 */
import type { AgentMemoryScope } from "../ports/agent-memory-scope";
import type { MemoryRepository } from "../ports/memory-repository";
import type {
  AgentHandle,
  AgentMetrics,
  BufferMeta,
  BufferSnapshot,
  AgentContextSnapshot,
  ExperienceRecord,
  PersonaDef,
  SkillRecord,
} from "../schemas";
import type { SaveBufferResult } from "../ports/memory-repository";

class ScopedAgentMemory implements AgentMemoryScope {
  constructor(
    private readonly repository: MemoryRepository,
    readonly role_id: string,
  ) {}

  getAgent(): Promise<AgentHandle> {
    return this.repository.getAgent(this.role_id);
  }

  getPersona(): Promise<PersonaDef> {
    return this.repository.getPersona(this.role_id);
  }

  getMetrics(): Promise<AgentMetrics> {
    return this.repository.getMetrics(this.role_id);
  }

  listSkills(): Promise<SkillRecord[]> {
    return this.repository.listSkills(this.role_id);
  }

  listExperiences(): Promise<ExperienceRecord[]> {
    return this.repository.listExperiences(this.role_id);
  }

  saveBufferSnapshot(
    snapshot: BufferSnapshot,
    agentContext?: AgentContextSnapshot,
  ): Promise<SaveBufferResult> {
    return this.repository.saveBufferSnapshot(this.role_id, snapshot, agentContext);
  }

  getBufferMeta(): Promise<BufferMeta> {
    return this.repository.getBufferMeta(this.role_id);
  }

  listPendingBufferSeqs(): Promise<number[]> {
    return this.repository.listPendingBufferSeqs(this.role_id);
  }

  getPendingBuffer(seq: number): Promise<{
    snapshot: BufferSnapshot;
    agentContext?: AgentContextSnapshot;
  } | undefined> {
    return this.repository.getPendingBuffer(this.role_id, seq);
  }

  markBufferProcessed(seq: number): Promise<void> {
    return this.repository.markBufferProcessed(this.role_id, seq);
  }

  markBufferDeadLetter(seq: number): Promise<void> {
    return this.repository.markBufferDeadLetter(this.role_id, seq);
  }

  saveExperience(experience: ExperienceRecord): Promise<void> {
    return this.repository.saveExperience(this.role_id, experience);
  }

  saveSkill(skill: SkillRecord): Promise<void> {
    return this.repository.saveSkill(this.role_id, skill);
  }

  updateExperience(experience: ExperienceRecord): Promise<void> {
    return this.repository.updateExperience(this.role_id, experience);
  }
}

export function createAgentMemoryScope(
  repository: MemoryRepository,
  role_id: string,
): AgentMemoryScope {
  return new ScopedAgentMemory(repository, role_id);
}
