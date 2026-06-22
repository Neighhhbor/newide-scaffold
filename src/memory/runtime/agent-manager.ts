/**
 * AgentManager 运行时（Boss）
 *
 * 管理 Agent 生命周期：createAgent、start/stop、竞标派单 submitTask。
 * 持有共享 MemoryRepository，为每个 Agent 创建独立 AgentMemoryScope；不直接写 buffer。
 */
import type { AgentHandle, CreateAgentSpec } from "../schemas";
import type { MemoryRepository } from "../ports/memory-repository";
import type { AgentTaskRequest } from "../agent-types";
import type { MemoryCycleResult } from "../types";
import { createAgentMemoryScope } from "../adapters/agent-memory-scope";
import { Agent } from "./agent";

/** submitTask 的返回：中标 Agent、竞标分数与记忆周期结果 */
export interface SubmitTaskResult {
  winner_role_id: string;
  scores: Record<string, number>;
  cycle: MemoryCycleResult;
}

export class AgentManager {
  private readonly agents = new Map<string, Agent>();
  private started = false;

  constructor(private readonly repository: MemoryRepository) {}

  static create(repository: MemoryRepository): AgentManager {
    return new AgentManager(repository);
  }

  async createAgent(spec: CreateAgentSpec): Promise<AgentHandle> {
    await this.repository.initializeAgent(spec);
    const memory = createAgentMemoryScope(this.repository, spec.role_id);
    const agent = new Agent(memory);
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
      throw new Error("No agents registered");
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
  let winner = "";
  let best = -Infinity;

  for (const [role_id, score] of Object.entries(scores)) {
    if (score > best) {
      best = score;
      winner = role_id;
    }
  }

  return winner;
}
