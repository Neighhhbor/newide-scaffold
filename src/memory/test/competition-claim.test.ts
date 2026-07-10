/**
 * Competition Claim 单元测试
 *
 * 验证：
 *   1. Agent.createCompetitionClaim 返回 participate 及正确 evidence
 *   2. 不相关 Agent → decline 声明含原因
 *   3. running/draining/retired → unavailable
 *   4. evaluator 抛出异常 → error 声明
 *   5. 声明过程不写 Buffer、不创建 Experience
 */
import { describe, it, expect } from 'vitest';
import { Agent } from '../runtime/agent';
import { InMemoryRepository } from '../adapters/in-memory-repository';
import { InMemoryBufferRepository } from '../adapters/in-memory-buffer-repository';
import { createAgentMemoryScope } from '../adapters/agent-memory-scope';
import { createMockCompetitionClaimEvaluator } from '../adapters/mock-competition-claim-evaluator';
import type { AgentTaskRequest } from '../agent-types';

describe('Agent.createCompetitionClaim', () => {
  async function createTestAgent(
    role_id: string,
    options?: {
      seedSkills?: number;
      seedExperiences?: number;
    },
  ) {
    const repository = new InMemoryRepository();
    const bufferRepository = new InMemoryBufferRepository();
    await repository.initializeAgent({ role_id, name: 'Test Agent', tags: [] });
    await bufferRepository.ensureAgent(role_id);
    const memory = createAgentMemoryScope(repository, bufferRepository, role_id);

    // 种子数据
    const now = new Date().toISOString();
    if (options?.seedSkills && options.seedSkills > 0) {
      for (let i = 0; i < options.seedSkills; i++) {
        await repository.saveSkill(role_id, {
          id: `skill_${role_id}_${i}`,
          description: `Skill ${i}`,
          description_embedding: [],
          content: `Skill content ${i}`,
          version: '1.0',
          review_status: 'approved',
          tags: ['test'],
          agent_id: role_id,
          promoted_at: now,
          created_at: now,
          updated_at: now,
        });
      }
    }
    if (options?.seedExperiences && options.seedExperiences > 0) {
      for (let i = 0; i < options.seedExperiences; i++) {
        const expId = `exp_${role_id}_${i}`;
        await repository.saveExperience(role_id, {
          id: expId,
          description: `Experience ${i}`,
          description_embedding: [],
          content: `Experience content ${i}`,
          confidence: 0.8,
          tags: ['test'],
          agent_id: role_id,
          type: 'positive',
          confidence_history: [],
          referenced_count: 0,
          source_task_id: `task_seed_${i}`,
          source_driver: 'seed-driver',
          created_at: now,
          updated_at: now,
        });
      }
    }

    return { repository, bufferRepository, memory, role_id };
  }

  function createTask(spec: string, task_id = 'task_claim_001'): AgentTaskRequest {
    return { spec, task_id, call_id: 'call_claim_001', source_driver: 'test-driver' };
  }

  describe('participate', () => {
    it('专业相关 Agent 返回 participate 声明', async () => {
      const { memory, role_id } = await createTestAgent('role_part', {
        seedSkills: 2,
        seedExperiences: 2,
      });
      const agent = new Agent(memory, undefined, undefined, createMockCompetitionClaimEvaluator());

      const claim = await agent.createCompetitionClaim(
        createTask('This is a relevant task for my expertise'),
      );

      expect(claim.role_id).toBe(role_id);
      expect(claim.decision).toBe('participate');
      expect(claim.confidence).toBe(0.85);
      expect(claim.evidence.skill_ids).toHaveLength(2);
      expect(claim.evidence.experience_ids).toHaveLength(2);
      expect(claim.evidence.persona_version).toBe(1);
      expect(claim.availability.agent_status).toBe('created');
      expect(claim.availability.loop_state).toBe('idle');
      expect(claim.generated_at).toBeTruthy();
    });

    it('evidence 中的 ID 来自 Agent 拥有的真实记忆', async () => {
      const { memory, role_id, repository } = await createTestAgent('role_evid', {
        seedSkills: 3,
        seedExperiences: 2,
      });
      const agent = new Agent(memory, undefined, undefined, createMockCompetitionClaimEvaluator());

      const skillsBefore = await repository.listSkills(role_id);
      const expsBefore = await repository.listExperiences(role_id);

      const claim = await agent.createCompetitionClaim(
        createTask('relevant task for evidence check'),
      );

      // evidence 中的 ID 都来自 Agent 的真实记忆
      expect(claim.evidence.skill_ids.every((id) => skillsBefore.some((s) => s.id === id))).toBe(
        true,
      );
      expect(claim.evidence.experience_ids.every((id) => expsBefore.some((e) => e.id === id))).toBe(
        true,
      );
    });
  });

  describe('decline', () => {
    it('不相关 Agent 返回 decline 声明', async () => {
      const { memory, role_id } = await createTestAgent('role_decline', {
        seedSkills: 1,
        seedExperiences: 1,
      });
      const agent = new Agent(memory, undefined, undefined, createMockCompetitionClaimEvaluator());

      const claim = await agent.createCompetitionClaim(
        createTask('This task is completely irrelevant to my skills'),
      );

      expect(claim.role_id).toBe(role_id);
      expect(claim.decision).toBe('decline');
      expect(claim.confidence).toBeNull();
      expect(claim.rationale).toBeTruthy();
      expect(claim.risks.length).toBeGreaterThan(0);
    });
  });

  describe('unavailable', () => {
    it('running 状态 Agent 返回 unavailable', async () => {
      const { memory } = await createTestAgent('role_unavail_run');
      const agent = new Agent(memory);
      // 模拟 running 状态
      agent.assignTask(createTask('test', 'task_occupied'));

      const claim = await agent.createCompetitionClaim(createTask('Any task'));
      expect(claim.decision).toBe('unavailable');
      expect(claim.availability.loop_state).toBe('running');
    });

    it('stopped 状态 Agent 返回 unavailable', async () => {
      const { memory } = await createTestAgent('role_unavail_stop');
      const agent = new Agent(memory);
      agent.stop();

      const claim = await agent.createCompetitionClaim(createTask('Any task'));
      expect(claim.decision).toBe('unavailable');
    });
  });

  describe('error', () => {
    it('evaluator 抛出异常时返回 error 声明', async () => {
      const { memory } = await createTestAgent('role_error');
      const agent = new Agent(memory, undefined, undefined, createMockCompetitionClaimEvaluator());

      const claim = await agent.createCompetitionClaim(
        createTask('error trigger - simulated LLM failure'),
      );

      expect(claim.decision).toBe('error');
      expect(claim.rationale).toContain('Mock evaluator');
    });
  });

  describe('side-effect-free', () => {
    it('声明过程不写 Buffer、不创建 Experience', async () => {
      const { memory, repository, bufferRepository, role_id } = await createTestAgent(
        'role_noside',
        { seedSkills: 1, seedExperiences: 1 },
      );
      const agent = new Agent(memory, undefined, undefined, createMockCompetitionClaimEvaluator());

      const skillsBefore = await repository.listSkills(role_id);
      const expsBefore = await repository.listExperiences(role_id);
      const metaBefore = await bufferRepository.getBufferMeta(role_id);

      await agent.createCompetitionClaim(createTask('relevant task'));

      // 记忆数未变
      const skillsAfter = await repository.listSkills(role_id);
      const expsAfter = await repository.listExperiences(role_id);
      expect(skillsAfter.length).toBe(skillsBefore.length);
      expect(expsAfter.length).toBe(expsBefore.length);

      // Buffer 未写入
      const metaAfter = await bufferRepository.getBufferMeta(role_id);
      expect(metaAfter.pending_count).toBe(metaBefore.pending_count);
      expect(metaAfter.cursor).toBe(metaBefore.cursor);

      // Agent 状态未变
      expect(agent.getState()).toBe('idle');
    });
  });
});
