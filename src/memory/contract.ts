/**
 * Memory 与 Coordinator 方向的跨模块契约
 *
 * 定义任务开始前装配上下文的 ContextPack、MemoryPolicy、BuildContextPackInput，
 * 以及 Coordinator 调用的 MemoryProvider 接口。不依赖 schemas 领域实体。
 */
import type {
  ArtifactId,
  ContextPackId,
  MemoryRef,
  RoleProfileRef,
  SchemaVersion,
  TaskId,
  Timestamp,
} from '../core';

/**
 * 上下文包 —— Memory 模块每次为任务装配的完整上下文
 *
 * 是 Coordinator → Agent 之间传递记忆信息的数据载体。
 * 包含任务关联的 Persona、经验记忆、技能引用和制品引用。
 */
export interface ContextPack {
  /** 上下文包唯一标识 */
  context_pack_id: ContextPackId;
  /** 关联的任务 ID */
  task_id: TaskId;
  /** 使用的角色画像引用 */
  role_profile_ref: RoleProfileRef;
  /** 装配的记忆条目引用列表（经验/技能） */
  memory_refs: MemoryRef[];
  /** 关联的制品 ID 列表（patch、transcript 等） */
  artifact_refs: ArtifactId[];
  /** 本次上下文装配的摘要说明 */
  summary: string;
  /** 创建时间戳 */
  created_at: Timestamp;
  /** Schema 版本号，用于数据迁移兼容 */
  schema_version: SchemaVersion;
}

/**
 * 记忆装配策略
 *
 * 控制 ContextPack 中包含哪些类型的记忆数据及数量上限，
 * 用于调节上下文窗口的 token 消耗和相关性精度。
 */
export interface MemoryPolicy {
  /** 是否包含 Persona 快照 */
  include_persona: boolean;
  /** 是否包含已批准的技能记录 */
  include_skills: boolean;
  /** 是否包含近期经验记录 */
  include_recent_experience: boolean;
  /** 最大记忆条目数（避免上下文膨胀） */
  max_memory_items: number;
}

/**
 * 构建 ContextPack 的输入参数
 *
 * 由 Coordinator 在每次任务分发前构造。
 * 最小必填字段为 task_id 和 role_profile_ref，其余可选。
 */
export interface BuildContextPackInput {
  /** 任务 ID */
  task_id: TaskId;
  /** 角色画像引用（决定使用哪个 Agent 的记忆） */
  role_profile_ref: RoleProfileRef;
  /** 预设的记忆引用列表（由上游策略决定） */
  memory_refs?: MemoryRef[];
  /** 预设的制品引用列表 */
  artifact_refs?: ArtifactId[];
  /** 上下文摘要提示（用于日志/调试，可由 Provider 覆盖） */
  summary_hint?: string;
}

/**
 * MemoryProvider —— Coordinatior 调用 Memory 模块的唯一入口
 *
 * 实现类由 adapter 提供（尚未实现）。
 */
export interface MemoryProvider {
  /** 根据输入参数装配并返回一个 ContextPack */
  buildContextPack(input: BuildContextPackInput): Promise<ContextPack>;
}
