/**
 * 记忆检索适配器（memory 内部）
 *
 * 从 AgentMemoryScope 读取 Skills / Experiences，经资格过滤后，
 * 按 **embedding 余弦相似度** 或 **tag 相关性** 筛选相关条目，返回完整实体（含 content）。
 *
 * 不含 Persona；不使用配额（quota）截断数量。
 * 不负责 DriverContext 组装 —— 组装见 services/driver-context.ts。
 *
 * ## 筛选规则
 *
 * 1. 资格过滤：approved skill、未晋升 positive experience
 * 2. 相关性过滤（满足其一即入选）：
 *    - cosine(task_embedding, item.description_embedding) ≥ min_embedding_similarity
 *    - tag 与 task_query 的重叠数 ≥ min_tag_overlap
 *
 * ## 调用链
 *
 * ```
 * repositoryRetrieveMemoryForTask → retrieveMemoriesForTask（本文件）
 * memory-cycle → buildDriverContext（services/driver-context.ts）
 * ```
 */
import type { EmbeddingProvider } from '../ports/embedding-provider';
import type { AgentMemoryScope } from '../ports/agent-memory-scope';
import type { ExperienceRecord, SkillRecord } from '../schemas';
import type { MemoryRetrievalResult } from '../services/memory-query';
import { defaultHashEmbeddingProvider } from './hash-embedding-provider';

/** 默认 embedding 相似度阈值（0~1）；低于此值且 tag 不命中则排除 */
const DEFAULT_MIN_EMBEDDING_SIMILARITY = 0.75;

/** 默认 tag 最少命中数（task_query token 与 tags 的交集） */
const DEFAULT_MIN_TAG_OVERLAP = 1;

/**
 * retrieveMemoriesForTask 的输入。
 * task_query 通常来自 task.spec，用于生成 task embedding 及 tag 匹配。
 */
export interface RetrieveMemoriesInput {
  task_query: string;
}

/**
 * 记忆相关性筛选策略。
 * 不包含配额字段；入选完全由 embedding / tag 相关性决定。
 */
export interface MemoryRelevancePolicy {
  include_skills: boolean;
  include_recent_experience: boolean;
  /** description_embedding 与 task embedding 的最低余弦相似度 */
  min_embedding_similarity: number;
  /** task_query 与 tags 的最低重叠命中数 */
  min_tag_overlap: number;
}

/**
 * 可选检索参数：策略覆盖与自定义 EmbeddingProvider。
 */
export interface MemoryRetrievalOptions {
  selection?: Partial<MemoryRelevancePolicy>;
  embedding?: EmbeddingProvider;
}

interface MemorySources {
  skills: SkillRecord[];
  experiences: ExperienceRecord[];
}

interface ScoredItem<T> {
  item: T;
  embedding_similarity: number;
  tag_overlap: number;
}

/**
 * 为任务检索相关记忆的主入口。
 *
 * 流水线：加载 → 资格过滤 → embedding/tag 相关性筛选 → 按相关度排序。
 */
export async function retrieveMemoriesForTask(
  scope: AgentMemoryScope,
  input: RetrieveMemoriesInput,
  options?: MemoryRetrievalOptions,
): Promise<MemoryRetrievalResult> {
  const embedding = options?.embedding ?? defaultHashEmbeddingProvider;
  const policy = resolveRelevancePolicy(options);
  const sources = await loadMemorySources(scope);
  const eligible = filterEligibleMemories(sources, policy);
  const taskEmbedding = await embedding.embed(input.task_query);

  const skills = await selectByRelevance(
    eligible.skills,
    input.task_query,
    taskEmbedding,
    policy,
    embedding,
  );
  const experiences = await selectByRelevance(
    eligible.experiences,
    input.task_query,
    taskEmbedding,
    policy,
    embedding,
  );

  return { skills, experiences };
}

async function loadMemorySources(scope: AgentMemoryScope): Promise<MemorySources> {
  const [skills, experiences] = await Promise.all([scope.listSkills(), scope.listExperiences()]);
  return { skills, experiences };
}

function resolveRelevancePolicy(options?: MemoryRetrievalOptions): MemoryRelevancePolicy {
  const overrides = options?.selection;
  return {
    include_skills: overrides?.include_skills ?? true,
    include_recent_experience: overrides?.include_recent_experience ?? true,
    min_embedding_similarity:
      overrides?.min_embedding_similarity ?? DEFAULT_MIN_EMBEDDING_SIMILARITY,
    min_tag_overlap: overrides?.min_tag_overlap ?? DEFAULT_MIN_TAG_OVERLAP,
  };
}

function filterEligibleMemories(
  sources: MemorySources,
  policy: MemoryRelevancePolicy,
): MemorySources {
  const skills = policy.include_skills
    ? sources.skills.filter(
        (skill) => skill.review_status === 'approved' && skill.market_status !== 'superseded',
      )
    : [];

  const experiences = policy.include_recent_experience
    ? sources.experiences.filter(
        (experience) => experience.type === 'positive' && !experience.promoted_to,
      )
    : [];

  return { skills, experiences };
}

/**
 * 按 embedding 余弦相似度或 tag 重叠筛选，并按相关度降序排列。
 * 入选条件：similarity ≥ 阈值 **或** tag_overlap ≥ 阈值。
 */
async function selectByRelevance<T extends SkillRecord | ExperienceRecord>(
  items: T[],
  task_query: string,
  taskEmbedding: number[],
  policy: MemoryRelevancePolicy,
  embedding: EmbeddingProvider,
): Promise<T[]> {
  const scored: ScoredItem<T>[] = [];

  for (const item of items) {
    const itemEmbedding = await resolveItemEmbedding(item, embedding);
    const embedding_similarity = embedding.cosineSimilarity(taskEmbedding, itemEmbedding);
    const tag_overlap = scoreTagOverlap(item.tags, task_query);
    const isRelevant =
      embedding_similarity >= policy.min_embedding_similarity ||
      tag_overlap >= policy.min_tag_overlap;

    if (isRelevant) {
      scored.push({ item, embedding_similarity, tag_overlap });
    }
  }

  return scored.sort((left, right) => compareRelevance(left, right)).map((entry) => entry.item);
}

/** 优先使用已存储的 description_embedding；维度不匹配时回退 embed(description) */
async function resolveItemEmbedding(
  item: SkillRecord | ExperienceRecord,
  embedding: EmbeddingProvider,
): Promise<number[]> {
  if (item.description_embedding.length === embedding.dimensions) {
    return item.description_embedding;
  }
  return embedding.embed(item.description);
}

function compareRelevance<T>(left: ScoredItem<T>, right: ScoredItem<T>): number {
  const leftScore = Math.max(left.embedding_similarity, normalizeTagScore(left.tag_overlap));
  const rightScore = Math.max(right.embedding_similarity, normalizeTagScore(right.tag_overlap));
  if (rightScore !== leftScore) {
    return rightScore - leftScore;
  }
  if (right.embedding_similarity !== left.embedding_similarity) {
    return right.embedding_similarity - left.embedding_similarity;
  }
  return right.tag_overlap - left.tag_overlap;
}

/** 将 tag 命中数映射到 0~1，便于与 embedding 分数联合排序 */
function normalizeTagScore(tag_overlap: number): number {
  return Math.min(1, tag_overlap / 3);
}

/**
 * 统计 task_query token 与 tags 的交集命中数。
 * token 与 tag 双向包含即算命中（忽略大小写）。
 */
function scoreTagOverlap(tags: string[], task_query: string): number {
  const queryTokens = tokenizeQuery(task_query);
  if (queryTokens.length === 0 || tags.length === 0) {
    return 0;
  }

  const normalizedTags = tags.map((tag) => tag.toLowerCase());
  let overlap = 0;

  for (const token of queryTokens) {
    const matched = normalizedTags.some((tag) => tag.includes(token) || token.includes(tag));
    if (matched) {
      overlap += 1;
    }
  }

  return overlap;
}

function tokenizeQuery(task_query: string): string[] {
  return task_query
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}
