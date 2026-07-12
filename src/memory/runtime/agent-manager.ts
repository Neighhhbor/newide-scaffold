/**
 * AgentManager 运行时（Boss）
 *
 * 管理 Agent 生命周期：createAgent、start/stop、竞标派单 submitTask。
 * 持有共享 MemoryRepository 与 BufferRepository，为每个 Agent 创建独立 AgentMemoryScope。
 * 支持通过 AgentManagerOptions.deps 注入 AgentRunDeps，替代默认 MVP 组合。
 */
import type { AgentHandle, CreateAgentSpec } from '../schemas';
import type { BufferRepository } from '../ports/buffer-repository';
import type { MemoryRepository } from '../ports/memory-repository';
import type { AgentTaskRequest } from '../agent-types';
import type { MemoryCycleResult } from '../types';
import type { AgentRunDeps } from './agent-run-deps';
import { createAgentMemoryScope } from '../adapters/agent-memory-scope';
import { Agent } from './agent';

/**
 * AgentManager 构造选项
 *
 * - `deps`: 可选的自定义 AgentRunDeps，覆盖默认 MVP 依赖（如注入真实 Driver / LLM 实现）
 */
export interface AgentManagerOptions {
  deps?: AgentRunDeps;
}

/** submitTask 的返回：中标 Agent、竞标分数与记忆周期结果 */
export interface SubmitTaskResult {
  winner_role_id: string;
  scores: Record<string, number>;
  cycle: MemoryCycleResult;
}

/**
 * 稳定的公开任务投影，供 Council / frontend 使用。
 * 从 SubmitTaskResult 派生，不触发额外存储读取。
 */
export interface MemoryTaskProjection {
  task_id: string;
  winner_role_id: string;
  scores: Record<string, number>;
  driver_summary: string;
  context: {
    skill_count: number;
    experience_count: number;
  };
  extraction: {
    experiences_created: number;
    experiences_updated: number;
    negative_experiences: number;
    skills_promoted: number;
  };
  promoted_skill_ids: string[];
  buffer_seq: number;
}

/** 将 SubmitTaskResult 映射为公开投影 */
export function toMemoryTaskProjection(result: SubmitTaskResult): MemoryTaskProjection {
  const { cycle } = result;
  return {
    task_id: cycle.buffer_snapshot.task_id,
    winner_role_id: result.winner_role_id,
    scores: result.scores,
    driver_summary: cycle.buffer_snapshot.driver_return.summary,
    context: {
      skill_count: cycle.driver_context.skills?.length ?? 0,
      experience_count: cycle.driver_context.experiences?.length ?? 0,
    },
    extraction: {
      experiences_created: cycle.extraction.result.experiences_created,
      experiences_updated: cycle.extraction.result.experiences_updated,
      negative_experiences: cycle.extraction.result.negative_experiences,
      skills_promoted: cycle.extraction.result.skills_promoted,
    },
    promoted_skill_ids: cycle.promotion.skill ? [cycle.promotion.skill.id] : [],
    buffer_seq: cycle.buffer_seq,
  };
}

export class AgentManager {
  private readonly agents = new Map<string, Agent>();
  private started = false;

  constructor(
    private readonly repository: MemoryRepository,
    private readonly bufferRepository: BufferRepository,
    private readonly options: AgentManagerOptions = {},
  ) {}

  /**
   * 创建 AgentManager 实例。
   *
   * - `AgentManager.create(repo, buf)` — 向后兼容，使用默认 MVP deps
   * - `AgentManager.create(repo, buf, { deps })` — 注入自定义 deps
   */
  static create(
    repository: MemoryRepository,
    bufferRepository: BufferRepository,
    options?: AgentManagerOptions,
  ): AgentManager {
    return new AgentManager(repository, bufferRepository, options);
  }

  async createAgent(spec: CreateAgentSpec): Promise<AgentHandle> {
    await this.repository.initializeAgent(spec);
    await this.bufferRepository.ensureAgent(spec.role_id);
    const memory = createAgentMemoryScope(this.repository, this.bufferRepository, spec.role_id);
    const agent = new Agent(memory, this.options.deps);
    this.agents.set(spec.role_id, agent);
    if (this.started) {
      agent.startLoop();
    }
    return agent.getHandle();
  }

  start(): void {
    this.started = true;
    for (const agent of this.agents.values()) {
      agent.startLoop();
    }
  }

  stop(): void {
    this.started = false;
    for (const agent of this.agents.values()) {
      agent.stop();
    }
  }

  wakeAll(): void {
    for (const agent of this.agents.values()) {
      agent.wake();
    }
  }

  async submitTask(request: AgentTaskRequest): Promise<SubmitTaskResult> {
    if (this.agents.size === 0) {
      throw new Error('No agents registered');
    }

    this.wakeAll();

    const scores: Record<string, number> = {};
    for (const [role_id, agent] of this.agents) {
      scores[role_id] = await agent.bid(request);
    }

    const winner_role_id = pickWinner(scores);
    const winner = this.agents.get(winner_role_id);
    if (!winner) {
      throw new Error(`Winner agent not found: ${winner_role_id}`);
    }

    const cycle = await winner.runOnce(request);
    return { winner_role_id, scores, cycle };
  }

  getAgent(role_id: string): Agent | undefined {
    return this.agents.get(role_id);
  }

  async listAgentHandles(): Promise<AgentHandle[]> {
    return Promise.all([...this.agents.values()].map((agent) => agent.getHandle()));
  }

  async retireAgent(_role_id: string): Promise<void> {
    // TODO
  }
}

function pickWinner(scores: Record<string, number>): string {
  let winner = '';
  let best = -Infinity;

  for (const [role_id, score] of Object.entries(scores)) {
    if (score > best) {
      best = score;
      winner = role_id;
    }
  }

  return winner;
}
