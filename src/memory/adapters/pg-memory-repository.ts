/**
 * PgMemoryRepository — MemoryRepository PostgreSQL + pgvector 适配器（骨架）
 *
 * 生产方向见 Spec §7.1：索引层 description_embedding 与载荷 JSON 同库。
 * 本迭代仅预留 Port 实现，不接真库。Buffer 见 BufferRepository。
 */
import type {
  AgentHandle,
  AgentMetrics,
  CreateAgentSpec,
  ExperienceRecord,
  PersonaDef,
  SkillRecord,
} from '../schemas';
import type { MemoryRepository, MemoryVectorSearchOptions } from '../ports/memory-repository';

const NOT_IMPLEMENTED = 'PgMemoryRepository: not implemented yet';

export class PgMemoryRepository implements MemoryRepository {
  async ensureAgent(_role_id: string): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async initializeAgent(_spec: CreateAgentSpec): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async getAgent(_role_id: string): Promise<AgentHandle> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async getPersona(_role_id: string): Promise<PersonaDef> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async getMetrics(_role_id: string): Promise<AgentMetrics> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async listSkills(_role_id: string): Promise<SkillRecord[]> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async listExperiences(_role_id: string): Promise<ExperienceRecord[]> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async searchSkills(
    _role_id: string,
    _options: MemoryVectorSearchOptions,
  ): Promise<SkillRecord[]> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async searchExperiences(
    _role_id: string,
    _options: MemoryVectorSearchOptions,
  ): Promise<ExperienceRecord[]> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async saveExperience(_role_id: string, _experience: ExperienceRecord): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async saveSkill(_role_id: string, _skill: SkillRecord): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async updateExperience(_role_id: string, _experience: ExperienceRecord): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }
}
