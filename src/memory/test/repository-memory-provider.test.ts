/**
 * RepositoryMemoryProvider 单元测试
 *
 * 预置 repository 数据 → buildContextPack → 断言 memory_refs 与 retrieveMemoriesForTask 一致。
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, nowTimestamp, type RoleProfileRef } from '../../core';
import { InMemoryRepository } from '../adapters/in-memory-repository';
import { InMemoryBufferRepository } from '../adapters/in-memory-buffer-repository';
import { HashEmbeddingProvider } from '../adapters/hash-embedding-provider';
import { RepositoryMemoryProvider } from '../adapters/repository-memory-provider';
import { createAgentMemoryScope } from '../adapters/agent-memory-scope';
import { retrieveMemoriesForTask } from '../adapters/memory-retrieval';
import type { ExperienceRecord, SkillRecord } from '../schemas';

const testEmbedding = new HashEmbeddingProvider();

function createRoleProfileRef(role_id: string, max_memory_items = 5): RoleProfileRef {
  return {
    role_id,
    persona_ref: `persona://${role_id}/current`,
    skill_refs: [],
    capability_tags: ['typescript', 'memory'],
    memory_policy: {
      allow_in_driver_context: true,
      allow_in_council_proposer: true,
      allow_in_council_judge: true,
      max_memory_items,
    },
    schema_version: SCHEMA_VERSION,
  };
}

function createSkill(role_id: string, overrides: Partial<SkillRecord> = {}): SkillRecord {
  const now = nowTimestamp();
  return {
    id: randomUUID(),
    description: 'Implement TypeScript memory retrieval patterns.',
    description_embedding: [],
    content: 'skill content for typescript memory retrieval',
    version: '1.0.0',
    review_status: 'approved',
    tags: ['typescript', 'memory'],
    promoted_at: now,
    agent_id: role_id,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function createExperience(
  role_id: string,
  overrides: Partial<ExperienceRecord> = {},
): ExperienceRecord {
  const now = nowTimestamp();
  return {
    id: randomUUID(),
    description: 'Prior TypeScript memory integration work.',
    description_embedding: [],
    content: 'experience content for typescript memory integration',
    confidence: 0.85,
    tags: ['typescript', 'memory'],
    agent_id: role_id,
    confidence_history: [{ value: 0.85, updated_at: now, reason: 'seed' }],
    referenced_count: 1,
    source_task_id: 'task_seed',
    source_driver: 'mock-driver',
    type: 'positive',
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe('RepositoryMemoryProvider', () => {
  it('buildContextPack maps repository retrieval into memory_refs', async () => {
    const repository = new InMemoryRepository(testEmbedding);
    const bufferRepository = new InMemoryBufferRepository();
    const role_id = 'role_context_pack';
    const task_query = 'typescript memory retrieval integration task';

    await repository.initializeAgent({ role_id, name: 'Context Pack Agent' });
    await bufferRepository.ensureAgent(role_id);

    const skill = createSkill(role_id);
    const experience = createExperience(role_id);
    await repository.saveSkill(role_id, skill);
    await repository.saveExperience(role_id, experience);

    const provider = new RepositoryMemoryProvider(repository, bufferRepository, testEmbedding);
    const role_profile_ref = createRoleProfileRef(role_id);

    const contextPack = await provider.buildContextPack({
      task_id: 'task_context_pack_001',
      role_profile_ref,
      summary_hint: task_query,
      artifact_refs: ['artifact_test_001'],
    });

    const scope = createAgentMemoryScope(repository, bufferRepository, role_id);
    const expectedRetrieval = await retrieveMemoriesForTask(
      scope,
      { task_query },
      {
        embedding: testEmbedding,
        selection: { max_memory_items: role_profile_ref.memory_policy.max_memory_items },
      },
    );

    expect(contextPack.memory_refs.length).toBeGreaterThan(0);
    expect(contextPack.artifact_refs).toEqual(['artifact_test_001']);
    expect(contextPack.summary).toContain('task_context_pack_001');
    expect(contextPack.role_profile_ref).toBe(role_profile_ref);

    const skillRefs = contextPack.memory_refs.filter((ref) => ref.kind === 'skill');
    const experienceRefs = contextPack.memory_refs.filter((ref) => ref.kind === 'experience');

    expect(skillRefs.map((ref) => ref.memory_id)).toEqual(
      expectedRetrieval.skills.map((item) => item.id),
    );
    expect(experienceRefs.map((ref) => ref.memory_id)).toEqual(
      expectedRetrieval.experiences.map((item) => item.id),
    );

    expect(skillRefs[0]).toMatchObject({
      kind: 'skill',
      memory_id: skill.id,
      uri: `memory://${role_id}/skill/${skill.id}`,
      summary: skill.description,
      schema_version: SCHEMA_VERSION,
    });
    expect(experienceRefs[0]).toMatchObject({
      kind: 'experience',
      memory_id: experience.id,
      uri: `memory://${role_id}/experience/${experience.id}`,
      summary: experience.description,
      schema_version: SCHEMA_VERSION,
    });
  });

  it('buildContextPack returns empty memory_refs when nothing matches', async () => {
    const repository = new InMemoryRepository(testEmbedding);
    const bufferRepository = new InMemoryBufferRepository();
    const role_id = 'role_context_pack_empty';

    await repository.initializeAgent({ role_id, name: 'Empty Context Pack Agent' });
    await bufferRepository.ensureAgent(role_id);

    const provider = new RepositoryMemoryProvider(repository, bufferRepository, testEmbedding);
    const contextPack = await provider.buildContextPack({
      task_id: 'task_context_pack_empty',
      role_profile_ref: createRoleProfileRef(role_id),
      summary_hint: 'unrelated quantum physics simulation',
    });

    expect(contextPack.memory_refs).toEqual([]);
    expect(contextPack.summary).toBe('No memories retrieved for task task_context_pack_empty');
  });

  it('respects role_profile_ref.memory_policy.max_memory_items', async () => {
    const repository = new InMemoryRepository(testEmbedding);
    const bufferRepository = new InMemoryBufferRepository();
    const role_id = 'role_context_pack_limit';

    await repository.initializeAgent({ role_id, name: 'Limit Context Pack Agent' });
    await bufferRepository.ensureAgent(role_id);

    for (let index = 0; index < 6; index += 1) {
      await repository.saveSkill(
        role_id,
        createSkill(role_id, {
          description: `TypeScript memory retrieval pattern ${index}`,
          tags: ['typescript', 'memory', `pattern-${index}`],
        }),
      );
    }

    const provider = new RepositoryMemoryProvider(repository, bufferRepository, testEmbedding);
    const contextPack = await provider.buildContextPack({
      task_id: 'task_context_pack_limit',
      role_profile_ref: createRoleProfileRef(role_id, 2),
      summary_hint: 'typescript memory retrieval patterns',
    });

    expect(contextPack.memory_refs).toHaveLength(2);
    expect(contextPack.summary).toContain('2 memories');
  });
});
