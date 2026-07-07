/**
 * AgentBoardQuery 集成测试
 *
 * 基于 InMemoryRepository，验证 4 个只读查询方法的行为：
 * listAgents / getAgent / listSkills / listExperiences。
 * 种子数据包含 3 个不同配置的 Agent，覆盖标签存在/缺失、
 * 技能/经验零值、负经验等场景。
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { nowTimestamp } from '../../core';
import { InMemoryRepository } from '../adapters/in-memory-repository';
import { RepositoryAgentBoardQuery } from '../adapters/agent-board-query';
import type { ExperienceRecord, SkillRecord } from '../schemas';

/** 当前时间戳（ISO） */
const NOW = nowTimestamp();

/** 通用经验工厂 */
function exp(agent_id: string, overrides: Partial<ExperienceRecord> = {}): ExperienceRecord {
  return {
    id: randomUUID(),
    description: `exp-${agent_id}-${overrides.id ?? 'default'}`,
    description_embedding: [],
    content: `Full content of experience for ${agent_id}.`,
    confidence: 0.85,
    tags: ['common'],
    agent_id,
    confidence_history: [{ value: 0.85, updated_at: NOW, reason: 'seed' }],
    referenced_count: 1,
    source_task_id: `task-${agent_id}-001`,
    source_driver: 'mock-driver',
    type: 'positive',
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

/** 通用技能工厂 */
function skill(agent_id: string, overrides: Partial<SkillRecord> = {}): SkillRecord {
  return {
    id: randomUUID(),
    description: `skill-${agent_id}-${overrides.id ?? 'default'}`,
    description_embedding: [],
    content: `Full content of skill for ${agent_id}.`,
    version: '1.0',
    review_status: 'approved',
    tags: ['common'],
    agent_id,
    promoted_from: undefined,
    promoted_at: NOW,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

/** 初始化种子数据并返回 RepositoryAgentBoardQuery */
async function setupBoardQuery() {
  const repo = new InMemoryRepository();

  // Agent A — 完整配置：有标签，2 技能，3 经验（含 1 负经验）
  await repo.initializeAgent({
    role_id: 'reviewer',
    name: 'Code Reviewer',
    tags: ['code-review', 'frontend'],
  });

  // 2 个技能
  await repo.saveSkill(
    'reviewer',
    skill('reviewer', { id: 'skill-a1', tags: ['static-analysis'] }),
  );
  await repo.saveSkill('reviewer', skill('reviewer', { id: 'skill-a2', tags: ['linting'] }));

  // 3 个经验：2 正 + 1 负（负经验带 linked_negative_exp）
  const negId = randomUUID();
  await repo.saveExperience(
    'reviewer',
    exp('reviewer', {
      id: 'exp-a1',
      tags: ['css'],
      confidence: 0.96,
      referenced_count: 5,
    }),
  );
  await repo.saveExperience(
    'reviewer',
    exp('reviewer', {
      id: 'exp-a2',
      tags: ['accessibility'],
      linked_negative_exp: [negId],
    }),
  );
  await repo.saveExperience(
    'reviewer',
    exp('reviewer', {
      id: negId,
      tags: ['css'],
      confidence: 0.1,
      type: 'negative',
      linked_negative_exp: undefined,
      referenced_count: 0,
    }),
  );

  // Agent B — 无标签，1 技能，0 经验
  await repo.initializeAgent({
    role_id: 'fixer',
    name: 'Bug Fixer',
  });
  await repo.saveSkill('fixer', skill('fixer', { id: 'skill-b1', tags: ['debug'] }));

  // Agent C — 全新：有标签，0 技能，0 经验
  await repo.initializeAgent({
    role_id: 'newbie',
    name: 'New Agent',
    tags: ['fresh'],
  });

  return {
    repo,
    query: new RepositoryAgentBoardQuery(repo),
  };
}

describe('AgentBoardQuery', () => {
  describe('listAgents', () => {
    it('返回全部已注册 Agent 的卡片摘要', async () => {
      const { query } = await setupBoardQuery();
      const list = await query.listAgents();

      expect(list).toHaveLength(3);

      const reviewer = list.find((a) => a.role_id === 'reviewer')!;
      expect(reviewer.name).toBe('Code Reviewer');
      expect(reviewer.tags).toEqual(['code-review', 'frontend']);
      expect(reviewer.skill_count).toBe(2);
      expect(reviewer.experience_count).toBe(3);
      expect(reviewer.persona_summary).toContain('reviewer');
    });

    it('未设置 tags 的 Agent 返回 undefined', async () => {
      const { query } = await setupBoardQuery();
      const list = await query.listAgents();
      const fixer = list.find((a) => a.role_id === 'fixer')!;

      expect(fixer.tags).toBeUndefined();
    });

    it('零技能的 Agent 技能/经验计数为 0', async () => {
      const { query } = await setupBoardQuery();
      const list = await query.listAgents();
      const newbie = list.find((a) => a.role_id === 'newbie')!;

      expect(newbie.skill_count).toBe(0);
      expect(newbie.experience_count).toBe(0);
    });
  });

  describe('getAgent', () => {
    it('返回 Agent 详情含完整 persona 和 raw + derived metrics', async () => {
      const { query } = await setupBoardQuery();
      const detail = await query.getAgent('reviewer');

      expect(detail.role_id).toBe('reviewer');
      expect(detail.name).toBe('Code Reviewer');
      expect(detail.tags).toEqual(['code-review', 'frontend']);

      // persona 全文
      expect(detail.persona.role_id).toBe('reviewer');
      expect(detail.persona.summary).toContain('reviewer');

      // raw metrics
      expect(detail.metrics.raw.skill_count).toBe(2);
      expect(detail.metrics.raw.experience_count).toBe(3);

      // derived metrics 实时计算
      expect(detail.metrics.derived.success_rate).toBe(0);
      expect(detail.metrics.derived.bid_win_rate).toBe(0);
      expect(typeof detail.metrics.derived.activity_score).toBe('number');

      // created_at
      expect(typeof detail.created_at).toBe('string');
    });

    it('不存在的 Agent 抛错', async () => {
      const { query } = await setupBoardQuery();
      await expect(query.getAgent('nonexistent')).rejects.toThrow('Agent not found');
    });
  });

  describe('listSkills', () => {
    it('返回技能列表且不含 description_embedding', async () => {
      const { query } = await setupBoardQuery();
      const skills = await query.listSkills('reviewer');

      expect(skills).toHaveLength(2);
      for (const s of skills) {
        expect(s).not.toHaveProperty('description_embedding');
        expect(typeof s.description).toBe('string');
        expect(typeof s.content).toBe('string');
        expect(typeof s.version).toBe('string');
      }
    });

    it('无技能的 Agent 返回空数组', async () => {
      const { query } = await setupBoardQuery();
      const skills = await query.listSkills('newbie');
      expect(skills).toEqual([]);
    });
  });

  describe('listExperiences', () => {
    it('返回经验列表，不含 description_embedding 和 linked_negative_exp', async () => {
      const { query } = await setupBoardQuery();
      const experiences = await query.listExperiences('reviewer');

      expect(experiences).toHaveLength(3);
      for (const e of experiences) {
        expect(e).not.toHaveProperty('description_embedding');
        expect(e).not.toHaveProperty('linked_negative_exp');
        expect(typeof e.description).toBe('string');
        expect(typeof e.content).toBe('string');
        expect(typeof e.confidence).toBe('number');
      }
    });

    it('正负经验都返回，且类型字段保留', async () => {
      const { query } = await setupBoardQuery();
      const experiences = await query.listExperiences('reviewer');

      const positive = experiences.filter((e) => e.type === 'positive');
      const negative = experiences.filter((e) => e.type === 'negative');
      expect(positive.length).toBeGreaterThanOrEqual(2);
      expect(negative).toHaveLength(1);
    });

    it('无经验的 Agent 返回空数组', async () => {
      const { query } = await setupBoardQuery();
      const experiences = await query.listExperiences('fixer');
      expect(experiences).toEqual([]);
    });
  });
});
