/**
 * MemoryRepository 持久化端口
 *
 * 定义 Agent 全部记忆数据的读写契约：Persona、Skills、Experiences、
 * pending/processed buffer、指标等。实现见 adapters/in-memory-repository.ts。
 */import type {
  AgentHandle,
  AgentMetrics,
  BufferMeta,
  BufferSnapshot,
  AgentContextSnapshot,
  CreateAgentSpec,
  ExperienceRecord,
  PersonaDef,
  SkillRecord,
} from "../schemas";

/** saveBufferSnapshot 的返回值 */
export interface SaveBufferResult {
  /** 分配的缓冲区序号（单调递增） */
  seq: number;
  /** 写入的缓冲区快照副本 */
  snapshot: BufferSnapshot;
  /** 若同时写入了 AgentContextSnapshot，则附带 */
  agent_context_snapshot?: AgentContextSnapshot;
}

export interface MemoryRepository {
  /** 确保 Agent 存在（不存在则用种子数据初始化） */
  ensureAgent(role_id: string): Promise<void>;

  /** 按 spec 注册新 Agent（已存在则抛错） */
  initializeAgent(spec: CreateAgentSpec): Promise<void>;

  /** 获取 Agent 聚合根 */
  getAgent(role_id: string): Promise<AgentHandle>;
  /** 获取当前 Persona 快照 */
  getPersona(role_id: string): Promise<PersonaDef>;
  /** 获取原始指标 */
  getMetrics(role_id: string): Promise<AgentMetrics>;
  /** 列出所有技能 */
  listSkills(role_id: string): Promise<SkillRecord[]>;
  /** 列出所有经验 */
  listExperiences(role_id: string): Promise<ExperienceRecord[]>;

  /** 保存缓冲区快照（配对可选 AgentContextSnapshot） */
  saveBufferSnapshot(
    role_id: string,
    snapshot: BufferSnapshot,
    agentContext?: AgentContextSnapshot,
  ): Promise<SaveBufferResult>;

  /** 持久化一条经验记录 */
  saveExperience(role_id: string, experience: ExperienceRecord): Promise<void>;
  /** 持久化一条技能记录 */
  saveSkill(role_id: string, skill: SkillRecord): Promise<void>;
  /** 更新已有经验（如晋升后写入 promoted_to） */
  updateExperience(role_id: string, experience: ExperienceRecord): Promise<void>;

  /** 获取缓冲区元数据（pending 计数、游标等） */
  getBufferMeta(role_id: string): Promise<BufferMeta>;
  /** 标记缓冲区为已处理（移动到 processed/） */
  markBufferProcessed(role_id: string, seq: number): Promise<void>;
  /** 标记缓冲区为死信（提取失败） */
  markBufferDeadLetter(role_id: string, seq: number): Promise<void>;

  /** 列出所有待处理缓冲区的 seq 列表 */
  listPendingBufferSeqs(role_id: string): Promise<number[]>;

  /** 获取指定 seq 的待处理缓冲区快照（含 agentContext） */
  getPendingBuffer(role_id: string, seq: number): Promise<{
    snapshot: BufferSnapshot;
    agentContext?: AgentContextSnapshot;
  } | undefined>;
}
