/**
 * driver-context 单元测试
 *
 * 验证 buildDriverContext 内部调用 queryMemory 并完成组装。
 */
import { describe, expect, it } from 'vitest';
import { createAgentMemoryScope } from '../adapters/agent-memory-scope';
import { InMemoryRepository } from '../adapters/in-memory-repository';
import { buildDriverContext } from '../services/driver-context';
import type { MemoryQueryStrategy } from '../services/memory-query';

describe('buildDriverContext', () => {
  it('calls queryMemory internally and merges results with task_instruction', async () => {
    const queryMemory: MemoryQueryStrategy = async () => ({
      skills: [
        {
          id: 'skill-1',
          description: 'Payment patterns',
          description_embedding: [],
          content: 'skill body',
          version: '1.0.0',
          review_status: 'approved',
          tags: ['payment'],
          promoted_at: '2026-01-01T00:00:00.000Z',
          agent_id: 'role_a',
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      ],
      experiences: [
        {
          id: 'exp-1',
          description: 'Prior gateway work',
          description_embedding: [],
          content: 'experience body',
          confidence: 0.8,
          tags: ['payment'],
          agent_id: 'role_a',
          confidence_history: [],
          referenced_count: 0,
          source_task_id: 'task_prior',
          source_driver: 'mock-driver',
          type: 'positive',
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    });

    const repository = new InMemoryRepository();
    await repository.initializeAgent({ role_id: 'role_a', name: 'Agent A' });
    const memory = createAgentMemoryScope(repository, 'role_a');

    const { driver_context, retrieval } = await buildDriverContext({
      memory,
      task: { spec: 'Refactor payment adapter.' },
      task_id: 'task_001',
      task_instruction: 'Implement the payment adapter refactor.',
      queryMemory,
    });

    expect(driver_context.task_instruction).toBe('Implement the payment adapter refactor.');
    expect(Object.keys(driver_context)).toEqual(['task_instruction', 'skills', 'experiences']);
    expect(driver_context.skills).toHaveLength(1);
    expect(driver_context.experiences).toHaveLength(1);
    expect(driver_context.skills[0]?.content).toBe('skill body');
    expect(retrieval).toEqual({
      skills: driver_context.skills,
      experiences: driver_context.experiences,
    });
  });

  it('returns empty memory lists when queryMemory finds nothing', async () => {
    const queryMemory: MemoryQueryStrategy = async () => ({
      skills: [],
      experiences: [],
    });

    const repository = new InMemoryRepository();
    await repository.initializeAgent({ role_id: 'role_empty', name: 'Empty' });
    const memory = createAgentMemoryScope(repository, 'role_empty');

    const { driver_context } = await buildDriverContext({
      memory,
      task: { spec: 'New task.' },
      task_id: 'task_empty',
      task_instruction: 'Execute scope.',
      queryMemory,
    });

    expect(driver_context.experiences).toEqual([]);
    expect(driver_context.skills).toEqual([]);
  });
});
