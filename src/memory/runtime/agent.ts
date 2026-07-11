/**
 * Agent 运行时（员工）
 *
 * 持有 AgentMemoryScope 与可注入的 AgentRunDeps；负责 bid、runOnce 状态机，
 * 将任务委托给 services/memory-cycle 完成「查记忆 → Driver → buffer → 提取 → 晋升」。
 */
import type { AgentHandle } from '../schemas';
import type { AgentMemoryScope } from '../ports/agent-memory-scope';
import type { AgentLoopState, AgentTaskRequest } from '../agent-types';
import type { MemoryCycleResult } from '../types';
import type { AgentRunDeps } from './agent-run-deps';
import type { MemoryCycleOptions } from '../services/memory-cycle';
import { runTaskMemoryCycle } from '../services/memory-cycle';
import { defaultMvpAgentRunDeps } from '../mvp/default-agent-run-deps';

export class Agent {
  private state: AgentLoopState = 'idle';
  private runQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly memory: AgentMemoryScope,
    private readonly deps: AgentRunDeps = defaultMvpAgentRunDeps,
  ) {}

  get role_id(): string {
    return this.memory.role_id;
  }

  getState(): AgentLoopState {
    return this.state;
  }

  getHandle(): Promise<AgentHandle> {
    return this.memory.getAgent();
  }

  startLoop(): void {
    if (this.state !== 'stopped') {
      this.state = 'sleeping';
    }
  }

  wake(): void {
    if (this.state === 'sleeping') {
      this.state = 'idle';
    }
  }

  stop(): void {
    this.state = 'stopped';
  }

  async bid(_task: AgentTaskRequest): Promise<number> {
    return 0.5;
  }

  /**
   * 执行一轮任务：memory-query → Driver → ingestTaskBuffer → processPendingBuffer
   * MVP 同步执行；后续可将 process 拆到异步调度。
   */
  async runOnce(task: AgentTaskRequest, options?: MemoryCycleOptions): Promise<MemoryCycleResult> {
    if (this.state === 'stopped') throw new Error(`Agent is stopped: ${this.role_id}`);
    const running = this.runQueue.then(async () => {
      if (this.state === 'stopped') throw new Error(`Agent is stopped: ${this.role_id}`);
      this.state = 'running';
      try {
        return await runTaskMemoryCycle(this.memory, task, this.deps, options);
      } finally {
        if (this.getState() !== 'stopped') this.state = 'sleeping';
      }
    });
    this.runQueue = running.then(
      () => undefined,
      () => undefined,
    );
    return running;
  }
}
