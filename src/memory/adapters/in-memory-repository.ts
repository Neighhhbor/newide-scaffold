/**
 * InMemoryRepository — MemoryRepository 内存适配器
 *
 * 所有 Agent 共享一个实例，数据按 role_id 隔离存储于内存 Map。
 * 含 pending buffer、experiences、skills、persona 等；无物理文件路径。
 */
import { nowTimestamp } from "../../core";
import type {
  AgentHandle,
  AgentMetrics,
  BufferMeta,
  BufferSnapshot,
  AgentContextSnapshot,
  CreateAgentSpec,
  ExperienceRecord,
  PersonaDef,
  SkillRecord,
} from "../schemas";
import type { MemoryRepository, SaveBufferResult } from "../ports/memory-repository";

interface PendingEntry {
  snapshot: BufferSnapshot;
  agentContext?: AgentContextSnapshot;
}

interface AgentStore {
  handle: AgentHandle;
  persona: PersonaDef;
  metrics: AgentMetrics;
  skills: SkillRecord[];
  experiences: ExperienceRecord[];
  bufferMeta: BufferMeta;
  pending: Map<number, PendingEntry>;
}

function createSeedPersona(role_id: string, persona_seed?: string): PersonaDef {
  const generated_at = nowTimestamp();
  return {
    role_id,
    version: 1,
    summary: persona_seed ?? `Seed persona for ${role_id}`,
    skills_overview: "No skills yet.",
    experience_coverage: "No experiences yet.",
    recent_performance: "Awaiting first task.",
    notes: "Initialized by InMemoryRepository.",
    generated_at,
  };
}

function createSeedMetrics(role_id: string): AgentMetrics {
  return {
    role_id,
    total_tasks: 0,
    tasks_bid: 0,
    tasks_won: 0,
    tasks_completed: 0,
    tasks_succeeded: 0,
    tasks_partial: 0,
    tasks_failed: 0,
    skill_count: 0,
    experience_count: 0,
    imported_skill_count: 0,
    promoted_skill_count: 0,
    avg_confidence: 0,
    token_cost_total: 0,
    persona_version: 1,
  };
}

function createSeedHandle(spec: CreateAgentSpec, persona: PersonaDef, metrics: AgentMetrics): AgentHandle {
  return {
    role_id: spec.role_id,
    name: spec.name,
    persona,
    skill_count: 0,
    experience_count: 0,
    status: "created",
    created_at: nowTimestamp(),
    tags: spec.tags,
    owned_skills: [],
    owned_exps: [],
    metric: metrics,
  };
}

function createEmptyBufferMeta(role_id: string): BufferMeta {
  return {
    role_id,
    pending_count: 0,
    cursor: 0,
    total_processed: 0,
    total_dead_letters: 0,
  };
}

export class InMemoryRepository implements MemoryRepository {
  private readonly agents = new Map<string, AgentStore>();

  async ensureAgent(role_id: string): Promise<void> {
    if (this.agents.has(role_id)) {
      return;
    }
    await this.initializeAgent({
      role_id,
      name: role_id,
    });
  }

  async initializeAgent(spec: CreateAgentSpec): Promise<void> {
    if (this.agents.has(spec.role_id)) {
      throw new Error(`Agent already exists: ${spec.role_id}`);
    }

    const persona = createSeedPersona(spec.role_id, spec.persona_seed);
    const metrics = createSeedMetrics(spec.role_id);
    const handle = createSeedHandle(spec, persona, metrics);

    this.agents.set(spec.role_id, {
      handle,
      persona,
      metrics,
      skills: [],
      experiences: [],
      bufferMeta: createEmptyBufferMeta(spec.role_id),
      pending: new Map(),
    });
  }

  async getAgent(role_id: string): Promise<AgentHandle> {
    return this.requireStore(role_id).handle;
  }

  async getPersona(role_id: string): Promise<PersonaDef> {
    return this.requireStore(role_id).persona;
  }

  async getMetrics(role_id: string): Promise<AgentMetrics> {
    return this.requireStore(role_id).metrics;
  }

  async listSkills(role_id: string): Promise<SkillRecord[]> {
    return [...this.requireStore(role_id).skills];
  }

  async listExperiences(role_id: string): Promise<ExperienceRecord[]> {
    return [...this.requireStore(role_id).experiences];
  }

  async saveBufferSnapshot(
    role_id: string,
    snapshot: BufferSnapshot,
    agentContext?: AgentContextSnapshot,
  ): Promise<SaveBufferResult> {
    const store = this.requireStore(role_id);
    const seq = store.bufferMeta.cursor + 1;
    store.bufferMeta.cursor = seq;
    store.bufferMeta.pending_count += 1;

    const storedSnapshot: BufferSnapshot = agentContext
      ? { ...snapshot, context_snapshot_ref: String(seq) }
      : snapshot;

    const storedAgentContext = agentContext
      ? {
          ...agentContext,
          driver_calls: agentContext.driver_calls.map((call) => ({
            ...call,
            driver_return_ref: `report_${seq}.json`,
          })),
        }
      : undefined;

    store.pending.set(seq, {
      snapshot: storedSnapshot,
      ...(storedAgentContext ? { agentContext: storedAgentContext } : {}),
    });

    return {
      seq,
      snapshot: storedSnapshot,
      ...(storedAgentContext ? { agent_context_snapshot: storedAgentContext } : {}),
    };
  }

  async saveExperience(role_id: string, experience: ExperienceRecord): Promise<void> {
    const store = this.requireStore(role_id);
    store.experiences.push(experience);
    store.handle.experience_count = store.experiences.length;
    store.handle.owned_exps.push(experience.id);
    store.metrics.experience_count = store.experiences.length;
  }

  async saveSkill(role_id: string, skill: SkillRecord): Promise<void> {
    const store = this.requireStore(role_id);
    store.skills.push(skill);
    store.handle.skill_count = store.skills.length;
    store.handle.owned_skills.push(skill.id);
    store.metrics.skill_count = store.skills.length;
    store.metrics.promoted_skill_count += 1;
  }

  async updateExperience(role_id: string, experience: ExperienceRecord): Promise<void> {
    const store = this.requireStore(role_id);
    const index = store.experiences.findIndex((item) => item.id === experience.id);
    if (index === -1) {
      throw new Error(`Experience not found: ${experience.id}`);
    }
    store.experiences[index] = experience;
  }

  async getBufferMeta(role_id: string): Promise<BufferMeta> {
    return { ...this.requireStore(role_id).bufferMeta };
  }

  async markBufferProcessed(role_id: string, seq: number): Promise<void> {
    const store = this.requireStore(role_id);
    const entry = store.pending.get(seq);
    if (!entry) {
      throw new Error(`Pending buffer not found: seq=${seq}`);
    }
    store.pending.delete(seq);
    store.bufferMeta.pending_count = Math.max(0, store.bufferMeta.pending_count - 1);
    store.bufferMeta.total_processed += 1;
    entry.snapshot.extraction_status = "processed";
  }

  async markBufferDeadLetter(role_id: string, seq: number): Promise<void> {
    const store = this.requireStore(role_id);
    const entry = store.pending.get(seq);
    if (!entry) {
      throw new Error(`Pending buffer not found: seq=${seq}`);
    }
    store.pending.delete(seq);
    store.bufferMeta.pending_count = Math.max(0, store.bufferMeta.pending_count - 1);
    store.bufferMeta.total_dead_letters += 1;
    entry.snapshot.extraction_status = "dead_letter";
  }

  async listPendingBufferSeqs(role_id: string): Promise<number[]> {
    return [...this.requireStore(role_id).pending.keys()].sort((a, b) => a - b);
  }

  async getPendingBuffer(
    role_id: string,
    seq: number,
  ): Promise<{ snapshot: BufferSnapshot; agentContext?: AgentContextSnapshot } | undefined> {
    const entry = this.requireStore(role_id).pending.get(seq);
    if (!entry) {
      return undefined;
    }
    return {
      snapshot: entry.snapshot,
      ...(entry.agentContext ? { agentContext: entry.agentContext } : {}),
    };
  }

  private requireStore(role_id: string): AgentStore {
    const store = this.agents.get(role_id);
    if (!store) {
      throw new Error(`Agent not found: ${role_id}`);
    }
    return store;
  }
}
