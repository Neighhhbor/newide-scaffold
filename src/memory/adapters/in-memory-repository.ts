/**
 * InMemoryRepository — MemoryRepository 内存适配器
 *
 * 所有 Agent 共享一个实例，数据按 role_id 隔离存储于内存 Map。
 * 含 experiences、skills、persona 等；buffer 见 InMemoryBufferRepository。
 */
import { nowTimestamp } from '../../core';
import type {
  AgentHandle,
  AgentMetrics,
  CreateAgentSpec,
  ExperienceRecord,
  PersonaDef,
  SkillRecord,
} from '../schemas';
import type { EmbeddingProvider } from '../ports/embedding-provider';
import type { MemoryRepository, MemoryVectorSearchOptions } from '../ports/memory-repository';
import { defaultHashEmbeddingProvider } from './hash-embedding-provider';

interface AgentStore {
  handle: AgentHandle;
  persona: PersonaDef;
  metrics: AgentMetrics;
  skills: SkillRecord[];
  experiences: ExperienceRecord[];
}

interface ScoredRecord<T> {
  item: T;
  similarity: number;
}

const DEFAULT_MIN_EXPERIENCE_CONFIDENCE = 0.2;
const DEFAULT_MIN_SIMILARITY = 0.5;

function createSeedPersona(role_id: string, persona_seed?: string): PersonaDef {
  const generated_at = nowTimestamp();
  return {
    role_id,
    version: 1,
    summary: persona_seed ?? `Seed persona for ${role_id}`,
    skills_overview: 'No skills yet.',
    experience_coverage: 'No experiences yet.',
    recent_performance: 'Awaiting first task.',
    notes: 'Initialized by InMemoryRepository.',
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

function createSeedHandle(
  spec: CreateAgentSpec,
  persona: PersonaDef,
  metrics: AgentMetrics,
): AgentHandle {
  return {
    role_id: spec.role_id,
    name: spec.name,
    persona,
    skill_count: 0,
    experience_count: 0,
    status: 'created',
    created_at: nowTimestamp(),
    tags: spec.tags,
    owned_skills: [],
    owned_exps: [],
    metric: metrics,
  };
}

function isEligibleSkill(skill: SkillRecord): boolean {
  return skill.review_status === 'approved' && skill.market_status !== 'superseded';
}

function isEligibleExperience(experience: ExperienceRecord, min_confidence: number): boolean {
  return (
    experience.type === 'positive' &&
    !experience.promoted_to &&
    experience.confidence >= min_confidence
  );
}

export class InMemoryRepository implements MemoryRepository {
  private readonly agents = new Map<string, AgentStore>();

  constructor(private readonly embedding: EmbeddingProvider = defaultHashEmbeddingProvider) {}

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

  async searchSkills(role_id: string, options: MemoryVectorSearchOptions): Promise<SkillRecord[]> {
    const eligible = this.requireStore(role_id).skills.filter(isEligibleSkill);
    return rankByVectorSimilarity(eligible, options, this.embedding);
  }

  async searchExperiences(
    role_id: string,
    options: MemoryVectorSearchOptions,
  ): Promise<ExperienceRecord[]> {
    const min_confidence = options.min_confidence ?? DEFAULT_MIN_EXPERIENCE_CONFIDENCE;
    const eligible = this.requireStore(role_id).experiences.filter((experience) =>
      isEligibleExperience(experience, min_confidence),
    );
    return rankByVectorSimilarity(eligible, options, this.embedding);
  }

  async saveExperience(role_id: string, experience: ExperienceRecord): Promise<void> {
    const store = this.requireStore(role_id);
    const stored = await this.withDescriptionEmbedding(experience);
    store.experiences.push(stored);
    store.handle.experience_count = store.experiences.length;
    store.handle.owned_exps.push(stored.id);
    store.metrics.experience_count = store.experiences.length;
  }

  async saveSkill(role_id: string, skill: SkillRecord): Promise<void> {
    const store = this.requireStore(role_id);
    const stored = await this.withDescriptionEmbedding(skill);
    store.skills.push(stored);
    store.handle.skill_count = store.skills.length;
    store.handle.owned_skills.push(stored.id);
    store.metrics.skill_count = store.skills.length;
    store.metrics.promoted_skill_count += 1;
  }

  async updateExperience(role_id: string, experience: ExperienceRecord): Promise<void> {
    const store = this.requireStore(role_id);
    const index = store.experiences.findIndex((item) => item.id === experience.id);
    if (index === -1) {
      throw new Error(`Experience not found: ${experience.id}`);
    }
    store.experiences[index] = await this.withDescriptionEmbedding(experience);
  }

  private async withDescriptionEmbedding<T extends SkillRecord | ExperienceRecord>(
    record: T,
  ): Promise<T> {
    if (record.description_embedding.length === this.embedding.dimensions) {
      return record;
    }
    return {
      ...record,
      description_embedding: await this.embedding.embed(record.description),
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

async function rankByVectorSimilarity<T extends SkillRecord | ExperienceRecord>(
  items: T[],
  options: MemoryVectorSearchOptions,
  embedding: EmbeddingProvider,
): Promise<T[]> {
  const scored: ScoredRecord<T>[] = [];

  for (const item of items) {
    const itemEmbedding =
      item.description_embedding.length === embedding.dimensions
        ? item.description_embedding
        : await embedding.embed(item.description);
    scored.push({
      item,
      similarity: embedding.cosineSimilarity(options.query_embedding, itemEmbedding),
    });
  }

  return scored
    .filter((entry) => entry.similarity >= (options.min_similarity ?? DEFAULT_MIN_SIMILARITY))
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, options.top_k)
    .map((entry) => entry.item);
}
