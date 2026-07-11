/**
 * Memory 全链路集成测试
 *
 * 验证 submitTask 完整周期：
 * repository 检索 → planTaskInstruction → mock Driver → buffer → 提取 → 晋升。
 */
import { describe, it, expect, vi } from 'vitest';
import { defaultMvpAgentRunDeps } from '../mvp/default-agent-run-deps';
import { AgentManager } from '../runtime/agent-manager';
import { InMemoryRepository } from '../adapters/in-memory-repository';
import { InMemoryBufferRepository } from '../adapters/in-memory-buffer-repository';
import { createAgentMemoryScope } from '../adapters/agent-memory-scope';
import { runTaskMemoryCycle } from '../services/memory-cycle';
import { ruleBasedSkillPromotion } from '../services/skill-promotion';
import type { AgentRunDeps } from '../runtime/agent-run-deps';
import type { AgentTaskRequest } from '../agent-types';

describe('memory MVP demo flow', () => {
  it('injects runtime deps and initializes the same role only once concurrently', async () => {
    const repository = new InMemoryRepository();
    const initialize = vi.spyOn(repository, 'initializeAgent');
    const bufferRepository = new InMemoryBufferRepository();
    const invokeDriver = vi.fn(defaultMvpAgentRunDeps.invokeDriver);
    const manager = AgentManager.create(repository, bufferRepository, {
      ...defaultMvpAgentRunDeps,
      queryMemory: async (memory) => ({
        experiences: await memory.listExperiences(),
        skills: await memory.listSkills(),
      }),
      invokeDriver,
    });

    await Promise.all([manager.ensureAgent('reviewer'), manager.ensureAgent('reviewer')]);
    await manager.runRole('reviewer', { spec: 'Use injected deps.', task_id: 'task_injected' });
    await manager.runRole('reviewer', { spec: 'Use injected deps.', task_id: 'task_reuse' });

    expect(initialize).toHaveBeenCalledTimes(1);
    expect(invokeDriver).toHaveBeenCalledTimes(2);
    expect(invokeDriver.mock.calls[1]?.[0].driver_context.experiences).toHaveLength(1);
  });
  it('createAgent → submitTask → 检索 → mock Driver → buffer → 提取 → 默认不晋升', async () => {
    const repository = new InMemoryRepository();
    const bufferRepository = new InMemoryBufferRepository();
    const manager = AgentManager.create(repository, bufferRepository);

    await manager.createAgent({
      role_id: 'role_ts_engineer',
      name: 'TypeScript Engineer',
      tags: ['typescript'],
    });
    manager.start();

    const task_id = 'task_mvp_001';
    const call_id = 'call_mvp_001';

    const result = await manager.submitTask({
      spec: 'Implement memory input MVP.',
      task_id,
      call_id,
      source_driver: 'mock-driver',
    });

    expect(result.winner_role_id).toBe('role_ts_engineer');
    expect(result.cycle.buffer_snapshot.task_id).toBe(task_id);
    expect(result.cycle.extraction.experiences).toHaveLength(1);
    expect(result.cycle.promotion.check.eligible).toBe(false);

    expect(result.cycle.driver_context.task_instruction).toBe(
      'Execute the driver task according to the planned scope.',
    );
    expect(result.cycle.driver_context.experiences).toEqual([]);
    expect(result.cycle.driver_context.skills).toEqual([]);

    const meta = await bufferRepository.getBufferMeta('role_ts_engineer');
    expect(meta.pending_count).toBe(0);
    expect(meta.total_processed).toBe(1);

    const experiences = await repository.listExperiences('role_ts_engineer');
    expect(experiences).toHaveLength(1);
    expect(experiences[0]?.source_task_id).toBe(task_id);
  });

  it('高置信度经验 → rule-based 技能晋升', async () => {
    const repository = new InMemoryRepository();
    const bufferRepository = new InMemoryBufferRepository();
    const role_id = 'role_promo';

    await repository.initializeAgent({ role_id, name: 'Promotion Agent', tags: [] });
    await bufferRepository.ensureAgent(role_id);
    const memory = createAgentMemoryScope(repository, bufferRepository, role_id);

    const deps: AgentRunDeps = {
      queryMemory: async () => ({ experiences: [], skills: [] }),
      planTaskInstruction: async () => 'Execute the task.',
      invokeDriver: async () => ({
        report: {
          summary: 'Task completed successfully.',
          artifacts: [],
          decisions: [{ point: 'Approach', options: ['A', 'B'], chosen: 'A', reason: 'Best fit' }],
          blockers: [],
          referenced_experiences: [
            { experience_id: 'exp_ref', applied: true, effectiveness: 'fully_effective', note: '' },
          ],
          assumptions: [],
        },
      }),
      extractor: {
        extract: async (snapshot) => ({
          experiences: [
            {
              id: '00000000-0000-0000-0000-000000000001',
              description: 'High confidence skill candidate',
              description_embedding: [0.1, 0.2, 0.3],
              content: 'Use approach A for this class of problems',
              confidence: 0.96,
              tags: ['approach'],
              agent_id: role_id,
              confidence_history: [],
              referenced_count: 0,
              source_task_id: snapshot.task_id,
              source_driver: snapshot.source_driver,
              type: 'positive',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ],
          result: {
            experiences_created: 1,
            experiences_updated: 0,
            negative_experiences: 0,
            skills_promoted: 0,
          },
        }),
      },
      promote: ruleBasedSkillPromotion,
      contextCleaner: { clean: async () => null },
    };

    const task: AgentTaskRequest = {
      spec: 'Trigger confidence-based skill promotion.',
      task_id: 'task_promo_001',
    };

    const result = await runTaskMemoryCycle(memory, task, deps);

    expect(result.promotion.check.eligible).toBe(true);
    expect(result.promotion.skill).toBeDefined();
    expect(result.promotion.skill!.review_status).toBe('pending');
    expect(result.extraction.result.skills_promoted).toBe(1);

    const skills = await repository.listSkills(role_id);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.promoted_from).toBe('00000000-0000-0000-0000-000000000001');

    const experiences = await repository.listExperiences(role_id);
    expect(experiences[0]?.promoted_to).toBe(skills[0]?.id);
  });
});
