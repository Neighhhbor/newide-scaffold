/**
 * memory-retrieval 单元测试
 *
 * 验证资格过滤、向量 top-K、confidence 门槛、总量截断与 content 保留。
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { nowTimestamp } from '../../core';
import { InMemoryRepository } from '../adapters/in-memory-repository';
import { InMemoryBufferRepository } from '../adapters/in-memory-buffer-repository';
import { createAgentMemoryScope } from '../adapters/agent-memory-scope';
import { retrieveMemoriesForTask } from '../adapters/memory-retrieval';
import { HashEmbeddingProvider } from '../adapters/hash-embedding-provider';
import type { ExperienceRecord, SkillRecord } from '../schemas';

const testEmbedding = new HashEmbeddingProvider();

function createScope(repository: InMemoryRepository, role_id: string) {
  return createAgentMemoryScope(repository, new InMemoryBufferRepository(), role_id);
}

function createExperience(
  role_id: string,
  overrides: Partial<ExperienceRecord> = {},
): ExperienceRecord {
  const now = nowTimestamp();
  return {
    id: randomUUID(),
    description: 'Handle TypeScript contract boundaries.',
    description_embedding: [],
    content: 'full experience content body',
    confidence: 0.8,
    tags: ['typescript', 'contracts'],
    agent_id: role_id,
    confidence_history: [{ value: 0.8, updated_at: now, reason: 'seed' }],
    referenced_count: 1,
    source_task_id: 'task_seed',
    source_driver: 'mock-driver',
    type: 'positive',
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function createSkill(role_id: string, overrides: Partial<SkillRecord> = {}): SkillRecord {
  const now = nowTimestamp();
  return {
    id: randomUUID(),
    description: 'Write stable TypeScript interfaces.',
    description_embedding: [],
    content: 'full skill content body',
    version: '1.0.0',
    review_status: 'approved',
    tags: ['typescript'],
    promoted_at: now,
    agent_id: role_id,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe('retrieveMemoriesForTask', () => {
  const retrievalOptions = { embedding: testEmbedding };

  it('returns empty lists for a new agent', async () => {
    const repository = new InMemoryRepository(testEmbedding);
    await repository.initializeAgent({ role_id: 'role_empty', name: 'Empty Agent' });
    const scope = createScope(repository, 'role_empty');

    const result = await retrieveMemoriesForTask(
      scope,
      { task_query: 'Do something new.' },
      retrievalOptions,
    );

    expect(result.skills).toEqual([]);
    expect(result.experiences).toEqual([]);
  });

  it('selects by tag relevance and eligibility with full content', async () => {
    const repository = new InMemoryRepository(testEmbedding);
    const role_id = 'role_select';
    await repository.initializeAgent({ role_id, name: 'Selector' });
    const scope = createScope(repository, role_id);

    const approved = createSkill(role_id);
    const pending = createSkill(role_id, {
      review_status: 'pending',
      tags: ['typescript'],
    });
    const promotedExperience = createExperience(role_id, {
      promoted_to: randomUUID(),
      tags: ['typescript'],
    });
    const eligibleExperience = createExperience(role_id, {
      description: 'Reusable contract pattern',
      content: 'detailed experience content',
      tags: ['typescript', 'contracts'],
    });
    const irrelevantExperience = createExperience(role_id, {
      description: 'Unrelated cooking recipe',
      tags: ['cooking'],
    });

    await repository.saveSkill(role_id, approved);
    await repository.saveSkill(role_id, pending);
    await repository.saveExperience(role_id, promotedExperience);
    await repository.saveExperience(role_id, eligibleExperience);
    await repository.saveExperience(role_id, irrelevantExperience);

    const result = await retrieveMemoriesForTask(
      scope,
      { task_query: 'typescript contract' },
      {
        ...retrievalOptions,
        selection: { recall_top_k: 0, min_tag_overlap: 1 },
      },
    );

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]?.id).toBe(approved.id);
    expect(result.experiences).toHaveLength(1);
    expect(result.experiences[0]?.id).toBe(eligibleExperience.id);
    expect(result.experiences[0]?.content).toBe('detailed experience content');
  });

  it('selects by embedding similarity when tags do not match', async () => {
    const repository = new InMemoryRepository(testEmbedding);
    const role_id = 'role_embed';
    await repository.initializeAgent({ role_id, name: 'Embedding Agent' });
    const scope = createScope(repository, role_id);

    const task_query = 'refactor payment gateway adapter';
    const taskEmbedding = await testEmbedding.embed(task_query);

    await repository.saveExperience(
      role_id,
      createExperience(role_id, {
        description: 'Payment gateway adapter migration notes',
        tags: [],
        description_embedding: taskEmbedding,
      }),
    );
    await repository.saveExperience(
      role_id,
      createExperience(role_id, {
        description: 'Gardening soil preparation',
        tags: ['gardening'],
        description_embedding: await testEmbedding.embed('unrelated gardening soil'),
      }),
    );

    const result = await retrieveMemoriesForTask(
      scope,
      { task_query },
      {
        embedding: testEmbedding,
        selection: { recall_top_k: 1, min_tag_overlap: 99 },
      },
    );

    expect(result.experiences).toHaveLength(1);
    expect(result.experiences[0]?.description).toContain('Payment gateway');
  });

  it('excludes all items when neither embedding nor tags are relevant', async () => {
    const repository = new InMemoryRepository(testEmbedding);
    const role_id = 'role_none';
    await repository.initializeAgent({ role_id, name: 'No Match Agent' });
    const scope = createScope(repository, role_id);

    await repository.saveExperience(
      role_id,
      createExperience(role_id, {
        description: 'Alpine skiing equipment checklist',
        tags: ['skiing'],
        description_embedding: await testEmbedding.embed('alpine skiing equipment'),
      }),
    );

    const result = await retrieveMemoriesForTask(
      scope,
      { task_query: 'typescript contract boundaries' },
      {
        ...retrievalOptions,
        selection: { recall_top_k: 20, min_tag_overlap: 2 },
      },
    );

    expect(result.experiences).toEqual([]);
    expect(result.skills).toEqual([]);
  });

  it('excludes vector hits below min_embedding_similarity even within top-K', async () => {
    const repository = new InMemoryRepository(testEmbedding);
    const role_id = 'role_threshold';
    await repository.initializeAgent({ role_id, name: 'Threshold Agent' });
    const scope = createScope(repository, role_id);

    await repository.saveExperience(
      role_id,
      createExperience(role_id, {
        description: 'Alpine skiing equipment checklist',
        tags: ['skiing'],
        description_embedding: await testEmbedding.embed('alpine skiing equipment'),
      }),
    );

    const result = await retrieveMemoriesForTask(
      scope,
      { task_query: 'typescript contract boundaries' },
      {
        ...retrievalOptions,
        selection: { recall_top_k: 20, min_embedding_similarity: 0.95, min_tag_overlap: 99 },
      },
    );

    expect(result.experiences).toEqual([]);
  });

  it('includes prior task experiences when query matches tags', async () => {
    const repository = new InMemoryRepository(testEmbedding);
    const role_id = 'role_roundtrip';
    await repository.initializeAgent({ role_id, name: 'Roundtrip Agent' });
    const scope = createScope(repository, role_id);

    const saved = createExperience(role_id, {
      description: 'Learned from prior task',
      tags: ['prior', 'task'],
      source_task_id: 'task_prior',
    });
    await repository.saveExperience(role_id, saved);

    const result = await retrieveMemoriesForTask(
      scope,
      { task_query: 'prior task' },
      retrievalOptions,
    );

    expect(result.experiences).toHaveLength(1);
    expect(result.experiences[0]?.id).toBe(saved.id);
  });

  it('excludes experiences below min_confidence', async () => {
    const repository = new InMemoryRepository(testEmbedding);
    const role_id = 'role_confidence';
    await repository.initializeAgent({ role_id, name: 'Confidence Agent' });
    const scope = createScope(repository, role_id);

    const lowConfidence = createExperience(role_id, {
      description: 'Low confidence typescript note',
      tags: ['typescript'],
      confidence: 0.1,
    });
    const highConfidence = createExperience(role_id, {
      description: 'High confidence typescript note',
      tags: ['typescript'],
      confidence: 0.8,
    });

    await repository.saveExperience(role_id, lowConfidence);
    await repository.saveExperience(role_id, highConfidence);

    const result = await retrieveMemoriesForTask(
      scope,
      { task_query: 'typescript' },
      {
        ...retrievalOptions,
        selection: { recall_top_k: 20, min_tag_overlap: 99 },
      },
    );

    expect(result.experiences).toHaveLength(1);
    expect(result.experiences[0]?.id).toBe(highConfidence.id);
  });

  it('limits total items to max_memory_items across skills and experiences', async () => {
    const repository = new InMemoryRepository(testEmbedding);
    const role_id = 'role_limit';
    await repository.initializeAgent({ role_id, name: 'Limit Agent' });
    const scope = createScope(repository, role_id);

    for (let index = 0; index < 4; index += 1) {
      await repository.saveSkill(
        role_id,
        createSkill(role_id, {
          description: `typescript skill ${index}`,
          tags: ['typescript'],
        }),
      );
    }
    for (let index = 0; index < 4; index += 1) {
      await repository.saveExperience(
        role_id,
        createExperience(role_id, {
          description: `typescript experience ${index}`,
          tags: ['typescript'],
        }),
      );
    }

    const result = await retrieveMemoriesForTask(
      scope,
      { task_query: 'typescript' },
      {
        ...retrievalOptions,
        selection: { max_memory_items: 3 },
      },
    );

    expect(result.skills.length + result.experiences.length).toBe(3);
  });

  it('auto-writes description_embedding on save', async () => {
    const repository = new InMemoryRepository(testEmbedding);
    const role_id = 'role_embed_save';
    await repository.initializeAgent({ role_id, name: 'Embed Save Agent' });

    const skill = createSkill(role_id, { description_embedding: [] });
    await repository.saveSkill(role_id, skill);

    const stored = await repository.listSkills(role_id);
    expect(stored[0]?.description_embedding).toHaveLength(testEmbedding.dimensions);
  });
});

describe('InMemoryRepository vector search', () => {
  it('returns top-K skills ordered by cosine similarity', async () => {
    const embedding = new HashEmbeddingProvider();
    const repository = new InMemoryRepository(embedding);
    const role_id = 'role_search';
    await repository.initializeAgent({ role_id, name: 'Search Agent' });

    const query = 'payment gateway refactor';
    const queryEmbedding = await embedding.embed(query);

    await repository.saveSkill(
      role_id,
      createSkill(role_id, {
        description: 'Payment gateway refactor patterns',
        description_embedding: queryEmbedding,
      }),
    );
    await repository.saveSkill(
      role_id,
      createSkill(role_id, {
        description: 'Unrelated gardening tips',
        description_embedding: await embedding.embed('gardening soil tips'),
      }),
    );

    const hits = await repository.searchSkills(role_id, {
      query_embedding: queryEmbedding,
      top_k: 1,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.description).toContain('Payment gateway');
  });

  it('filters out items below min_similarity', async () => {
    const embedding = new HashEmbeddingProvider();
    const repository = new InMemoryRepository(embedding);
    const role_id = 'role_min_sim';
    await repository.initializeAgent({ role_id, name: 'Min Sim Agent' });

    const queryEmbedding = await embedding.embed('typescript contract boundaries');

    await repository.saveSkill(
      role_id,
      createSkill(role_id, {
        description: 'Alpine skiing equipment checklist',
        description_embedding: await embedding.embed('alpine skiing equipment'),
      }),
    );

    const hits = await repository.searchSkills(role_id, {
      query_embedding: queryEmbedding,
      top_k: 10,
      min_similarity: 0.95,
    });

    expect(hits).toEqual([]);
  });
});
