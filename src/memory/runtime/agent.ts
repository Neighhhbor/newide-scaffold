/**
 * Agent 运行时（员工）
 *
 * 持有 AgentMemoryScope 与可注入的 AgentRunDeps；负责 bid、runOnce 状态机。
 *
 * 当前 runOnce 是 MVP 同步单轮路径，会委托 services/memory-cycle 完成
 *「查记忆 → Driver → buffer → 提取 → 晋升」。目标态持久 run loop 仍是占位。
 */
import type { AgentHandle } from '../schemas';
import type { AgentMemoryScope } from '../ports/agent-memory-scope';
import type { AgentLoopState, AgentLoopTickResult, AgentTaskRequest } from '../agent-types';
import type { MemoryCycleResult } from '../types';
import type { AgentRunDeps } from './agent-run-deps';
import { runTaskMemoryCycle } from '../services/memory-cycle';
import { defaultMvpAgentRunDeps } from '../mvp/default-agent-run-deps';

export class Agent {
  private state: AgentLoopState = 'idle';

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

  /**
   * 目标态持久 run loop 入口占位。
   *
   * 当前不会启动后台 worker 或任务队列，只把 Agent 放入 sleeping 状态，等待
   * AgentManager.submitTask 通过 MVP runOnce 路径显式派发任务。
   */
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
   * 目标态持久 run loop 的单步执行占位。
   *
   * 这里故意不消费任务、不调用 Driver、不写 buffer。当前可运行链路仍是 runOnce；
   * 后续接入任务队列或调度器时，再把真正的 loop tick 行为接到这里。
   */
  async runLoopTick(): Promise<AgentLoopTickResult> {
    return {
      status: 'skipped',
      reason:
        'Persistent agent run loop is not implemented yet; runOnce is the MVP synchronous path.',
    };
  }

  /**
   * MVP 同步单轮任务路径。
   *
   * 这不是目标态持久 Agent run loop。它为演示和集成测试同步跑完整闭环：
   * memory-query → Driver → ingestTaskBuffer → processPendingBuffer。
   * 后续目标态应将 buffer 提取、技能晋升等任务后处理拆到异步处理器。
   */
  async runOnce(task: AgentTaskRequest): Promise<MemoryCycleResult> {
    this.state = 'running';
    try {
      return await runTaskMemoryCycle(this.memory, task, this.deps);
    } finally {
      this.state = 'sleeping';
    }
  }
}
