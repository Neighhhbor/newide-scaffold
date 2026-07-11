/**
 * AgentManager 运行时（Boss）
 *
 * 管理 Agent 生命周期：createAgent、start/stop、竞标派单 submitTask。
 * 持有共享 MemoryRepository 与 BufferRepository，为每个 Agent 创建独立 AgentMemoryScope。
 */
import type { AgentHandle, CreateAgentSpec } from '../schemas';
import type { BufferRepository } from '../ports/buffer-repository';
import type { MemoryRepository } from '../ports/memory-repository';
import type { AgentTaskRequest } from '../agent-types';
import type { MemoryCycleResult } from '../types';
import { createAgentMemoryScope } from '../adapters/agent-memory-scope';
import { Agent } from './agent';
import type { AgentRunDeps } from './agent-run-deps';
import { defaultMvpAgentRunDeps } from '../mvp/default-agent-run-deps';
import type { MemoryCycleOptions } from '../services/memory-cycle';

/** submitTask 的返回：中标 Agent、竞标分数与记忆周期结果 */
export interface SubmitTaskResult {
  winner_role_id: string;
  scores: Record<string, number>;
  cycle: MemoryCycleResult;
}

export class AgentManager {
  private readonly agents = new Map<string, Agent>();
  private readonly pendingAgents = new Map<string, Promise<Agent>>();
  private started = false;

  constructor(
    private readonly repository: MemoryRepository,
    private readonly bufferRepository: BufferRepository,
    private readonly deps: AgentRunDeps = defaultMvpAgentRunDeps,
  ) {}

  static create(
    repository: MemoryRepository,
    bufferRepository: BufferRepository,
    deps: AgentRunDeps = defaultMvpAgentRunDeps,
  ): AgentManager {
    return new AgentManager(repository, bufferRepository, deps);
  }

  async createAgent(spec: CreateAgentSpec): Promise<AgentHandle> {
    await this.repository.initializeAgent(spec);
    await this.bufferRepository.ensureAgent(spec.role_id);
    const memory = createAgentMemoryScope(this.repository, this.bufferRepository, spec.role_id);
    const agent = new Agent(memory, this.deps);
    this.agents.set(spec.role_id, agent);
    if (this.started) {
      agent.startLoop();
    }
    return agent.getHandle();
  }

  async ensureAgent(role_id: string): Promise<Agent> {
    const existing = this.agents.get(role_id);
    if (existing) return existing;
    const pending = this.pendingAgents.get(role_id);
    if (pending) return pending;
    const creating = this.createAgent({ role_id, name: role_id })
      .then(() => {
        const agent = this.agents.get(role_id);
        if (!agent) throw new Error(`Agent initialization failed: ${role_id}`);
        return agent;
      })
      .finally(() => this.pendingAgents.delete(role_id));
    this.pendingAgents.set(role_id, creating);
    return creating;
  }

  async runRole(
    role_id: string,
    task: AgentTaskRequest,
    options?: MemoryCycleOptions,
  ): Promise<MemoryCycleResult> {
    const agent = await this.ensureAgent(role_id);
    return agent.runOnce(task, options);
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
