/**
 * driver-context-builder 单元测试
 *
 * 验证资格过滤、embedding/tag 相关性筛选与 content 保留。
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { nowTimestamp } from '../../core';
import { InMemoryRepository } from '../adapters/in-memory-repository';
import { createAgentMemoryScope } from '../adapters/agent-memory-scope';
import { retrieveMemoriesForTask } from '../adapters/driver-context-builder';
import { HashEmbeddingProvider } from '../adapters/hash-embedding-provider';
import type { ExperienceRecord, SkillRecord } from '../schemas';

const testEmbedding = new HashEmbeddingProvider();

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
  const builderOptions = { embedding: testEmbedding };

  it('returns empty lists for a new agent', async () => {
    const repository = new InMemoryRepository();
    await repository.initializeAgent({ role_id: 'role_empty', name: 'Empty Agent' });
    const scope = createAgentMemoryScope(repository, 'role_empty');

    const result = await retrieveMemoriesForTask(
      scope,
      { task_query: 'Do something new.' },
      builderOptions,
    );

    expect(result.skills).toEqual([]);
    expect(result.experiences).toEqual([]);
  });

  it('selects by tag relevance and eligibility with full content', async () => {
    const repository = new InMemoryRepository();
    const role_id = 'role_select';
    await repository.initializeAgent({ role_id, name: 'Selector' });
    const scope = createAgentMemoryScope(repository, role_id);

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
        ...builderOptions,
        selection: { min_embedding_similarity: 1.0, min_tag_overlap: 1 },
      },
    );

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]?.id).toBe(approved.id);
    expect(result.experiences).toHaveLength(1);
    expect(result.experiences[0]?.id).toBe(eligibleExperience.id);
    expect(result.experiences[0]?.content).toBe('detailed experience content');
  });

  it('selects by embedding similarity when tags do not match', async () => {
    const repository = new InMemoryRepository();
    const role_id = 'role_embed';
    await repository.initializeAgent({ role_id, name: 'Embedding Agent' });
    const scope = createAgentMemoryScope(repository, role_id);

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
        selection: { min_embedding_similarity: 0.95, min_tag_overlap: 99 },
      },
    );

    expect(result.experiences).toHaveLength(1);
    expect(result.experiences[0]?.description).toContain('Payment gateway');
  });

  it('excludes all items when neither embedding nor tags are relevant', async () => {
    const repository = new InMemoryRepository();
    const role_id = 'role_none';
    await repository.initializeAgent({ role_id, name: 'No Match Agent' });
    const scope = createAgentMemoryScope(repository, role_id);

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
        ...builderOptions,
        selection: { min_embedding_similarity: 0.95, min_tag_overlap: 2 },
      },
    );

    expect(result.experiences).toEqual([]);
    expect(result.skills).toEqual([]);
  });

  it('includes prior task experiences when query matches tags', async () => {
    const repository = new InMemoryRepository();
    const role_id = 'role_roundtrip';
    await repository.initializeAgent({ role_id, name: 'Roundtrip Agent' });
    const scope = createAgentMemoryScope(repository, role_id);

    const saved = createExperience(role_id, {
      description: 'Learned from prior task',
      tags: ['prior', 'task'],
      source_task_id: 'task_prior',
    });
    await repository.saveExperience(role_id, saved);

    const result = await retrieveMemoriesForTask(
      scope,
      { task_query: 'prior task' },
      builderOptions,
    );

    expect(result.experiences).toHaveLength(1);
    expect(result.experiences[0]?.id).toBe(saved.id);
  });
});
