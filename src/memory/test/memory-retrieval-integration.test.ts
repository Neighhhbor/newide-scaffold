/**
 * 记忆检索集成测试
 *
 * 预置 skill/experience → submitTask → 断言 driver_context 非空且 skills 在 experiences 之前。
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { nowTimestamp } from '../../core';
import { InMemoryRepository } from '../adapters/in-memory-repository';
import { InMemoryBufferRepository } from '../adapters/in-memory-buffer-repository';
import { HashEmbeddingProvider } from '../adapters/hash-embedding-provider';
import { AgentManager } from '../runtime/agent-manager';
import type { ExperienceRecord, SkillRecord } from '../schemas';

const testEmbedding = new HashEmbeddingProvider();

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

describe('memory retrieval integration', () => {
  it('submitTask retrieves pre-seeded memories into driver_context', async () => {
    const repository = new InMemoryRepository(testEmbedding);
    const bufferRepository = new InMemoryBufferRepository();
    const manager = AgentManager.create(repository, bufferRepository);
    const role_id = 'role_integration';

    await manager.createAgent({
      role_id,
      name: 'Integration Agent',
      tags: ['typescript'],
    });
    manager.start();

    const skill = createSkill(role_id);
    const experience = createExperience(role_id);
    await repository.saveSkill(role_id, skill);
    await repository.saveExperience(role_id, experience);

    const result = await manager.submitTask({
      spec: 'typescript memory retrieval integration task',
      task_id: 'task_integration_001',
      call_id: 'call_integration_001',
      source_driver: 'mock-driver',
    });

    const { driver_context, retrieval } = result.cycle;

    expect(Object.keys(driver_context)).toEqual(['task_instruction', 'skills', 'experiences']);
    expect(driver_context.skills.length + driver_context.experiences.length).toBeGreaterThan(0);
    expect(driver_context.skills.length).toBeGreaterThan(0);
    expect(driver_context.experiences.length).toBeGreaterThan(0);

    const skillIndex = Object.keys(driver_context).indexOf('skills');
    const experienceIndex = Object.keys(driver_context).indexOf('experiences');
    expect(skillIndex).toBeLessThan(experienceIndex);

    expect(retrieval.skills).toEqual(driver_context.skills);
    expect(retrieval.experiences).toEqual(driver_context.experiences);
    expect(driver_context.skills[0]?.content).toBe('skill content for typescript memory retrieval');
    expect(driver_context.experiences[0]?.content).toBe(
      'experience content for typescript memory integration',
    );
  });

  it('submitTask returns empty memory when agent has no pre-seeded items', async () => {
    const repository = new InMemoryRepository(testEmbedding);
    const bufferRepository = new InMemoryBufferRepository();
    const manager = AgentManager.create(repository, bufferRepository);

    await manager.createAgent({
      role_id: 'role_no_memory',
      name: 'Empty Memory Agent',
    });
    manager.start();

    const result = await manager.submitTask({
      spec: 'unrelated quantum physics simulation',
      task_id: 'task_empty_001',
    });

    expect(result.cycle.driver_context.skills).toEqual([]);
    expect(result.cycle.driver_context.experiences).toEqual([]);
  });
});
