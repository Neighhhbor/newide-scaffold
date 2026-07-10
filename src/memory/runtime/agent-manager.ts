/**
 * AgentManager 运行时（Boss）
 *
 * 管理 Agent 生命周期：createAgent、start/stop、竞标派单 submitTask。
 * 持有共享 MemoryRepository 与 BufferRepository，为每个 Agent 创建独立 AgentMemoryScope。
 * 支持通过 AgentManagerOptions.deps 注入 AgentRunDeps，替代默认 MVP 组合。
 * 支持通过 AgentManagerOptions.tools 注入 AgentToolConfig，启用 tool-calling 模式。
 */
import type { AgentHandle, CreateAgentSpec } from '../schemas';
import type { BufferRepository } from '../ports/buffer-repository';
import type { MemoryRepository } from '../ports/memory-repository';
import type { AgentTaskRequest } from '../agent-types';
import type { AgentLoopTickResult } from '../agent-types';
import type { MemoryCycleResult } from '../types';
import type { AgentRunDeps } from './agent-run-deps';
import type { AgentToolConfig } from './agent';
import type { CompetitionClaimEvaluator } from '../ports/competition-claim-evaluator';
import type { CompetitionClaimBatch, CollectCompetitionClaimsOptions } from '../competition-types';
import { createAgentMemoryScope } from '../adapters/agent-memory-scope';
import { QueryMemoryTool } from './tools/query-memory-tool';
import { Agent } from './agent';
import { createId, nowTimestamp } from '../../core';

/**
 * AgentManager 构造选项
 *
 * - `deps`: 可选的自定义 AgentRunDeps，覆盖默认 MVP 依赖（如注入真实 Driver / LLM 实现）
 * - `tools`: 可选的 tool-calling 配置，启用时 Agent 使用 LLM tool-calling 替代固定 pipeline
 * - `evaluator`: 可选的 CompetitionClaimEvaluator，用于 Agent 参选声明生成（默认使用 Mock）
 */
export interface AgentManagerOptions {
  deps?: AgentRunDeps;
  tools?: AgentToolConfig;
  evaluator?: CompetitionClaimEvaluator;
}

/** submitTask 的返回：中标 Agent、竞标分数与记忆周期结果（仅用于向后兼容） */
export interface SubmitTaskResult {
  winner_role_id: string;
  scores: Record<string, number>;
  /** 记忆周期结果（执行完成后的完整结果） */
  cycle: MemoryCycleResult;
  /** 执行状态 */
  status: 'completed';
}

/**
 * dispatchTask 的返回结果。
 *
 * - 不包含 winner_role_id 和 scores（Memory 不负责选赢家）
 * - role_id 即 dispatchTask 指定的目标 Agent
 * - status 反映任务执行结果
 */
export interface DispatchTaskResult {
  role_id: string;
  status:
    | 'completed'
    | 'failed'
    | 'blocked'
    | 'cancelled'
    | 'no_driver_invocation'
    | 'max_rounds_exceeded';
  /** 记忆周期结果（执行完成后的完整结果） */
  cycle: MemoryCycleResult;
}

/**
 * 稳定的公开任务投影，供 Council / frontend 使用。
 * 从 DispatchTaskResult 派生，不触发额外存储读取。
 *
 * 移除了 winner_role_id 和 scores（上层负责选赢家记录）。
 * Council 如需这些信息应在调用 dispatchTask 前自行保存决策记录。
 */
export interface MemoryTaskProjection {
  task_id: string;
  role_id: string;
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

/** 将 DispatchTaskResult 或 SubmitTaskResult 映射为公开投影 */
export function toMemoryTaskProjection(
  result: DispatchTaskResult | SubmitTaskResult,
): MemoryTaskProjection {
  const { cycle } = result;
  // 兼容两种结果类型：DispatchTaskResult.role_id 或 SubmitTaskResult.winner_role_id
  const role_id =
    'role_id' in result ? result.role_id : (result as SubmitTaskResult).winner_role_id;
  return {
    task_id: cycle.buffer_snapshot.task_id,
    role_id,
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
   * - `AgentManager.create(repo, buf, { tools })` — 启用 tool-calling 模式
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

    // 工具模式：自动注入 QueryMemoryTool（需要 AgentMemoryScope，只能在这里创建）
    const tools = this.options.tools
      ? {
          ...this.options.tools,
          tools: [new QueryMemoryTool(memory), ...this.options.tools.tools],
        }
      : undefined;

    const agent = new Agent(memory, this.options.deps, tools, this.options.evaluator);
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

  /**
   * 收集所有 Agent 对一次任务机会的参选声明。
   *
   * 实现 AgentCompetitionQuery 端口。
   *
   * - 从 repository 获取已注册的 Agent ID，补齐缺失的运行时实例
   * - 不可用状态（running/draining/retired）Agent → 直接返回 unavailable
   * - 可用 Agent 并行唤醒并生成声明
   * - 超时/异常 Agent 分别转换为 timeout/error 声明，不阻塞其他
   * - 结果按 role_id 排序，保证调用方不依赖异步完成顺序
   * - 不占用任务槽、不改变 Agent 状态为 running
   */
  async collectCompetitionClaims(
    task: AgentTaskRequest,
    options?: CollectCompetitionClaimsOptions,
  ): Promise<CompetitionClaimBatch> {
    const correlation_id = createId('corr');
    const started_at = nowTimestamp();
    const timeout_ms = options?.timeout_ms ?? 10_000;

    // 1. 补齐缺失的运行时 Agent 实例
    const registeredIds = await this.repository.listAgentIds();
    for (const role_id of registeredIds) {
      if (!this.agents.has(role_id)) {
        await this.repository.ensureAgent(role_id);
        await this.bufferRepository.ensureAgent(role_id);
        const memory = createAgentMemoryScope(this.repository, this.bufferRepository, role_id);
        const tools = this.options.tools
          ? {
              ...this.options.tools,
              tools: [new QueryMemoryTool(memory), ...this.options.tools.tools],
            }
          : undefined;
        const agent = new Agent(memory, this.options.deps, tools, this.options.evaluator);
        this.agents.set(role_id, agent);
      }
    }

    // 2. 并行收集声明
    const agentEntries = [...this.agents.entries()];

    const claimPromises = agentEntries.map(async ([role_id, agent]) => {
      // 超时控制
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), timeout_ms),
      );

      try {
        const claim = await Promise.race([agent.createCompetitionClaim(task), timeoutPromise]);
        return claim;
      } catch (err) {
        const isTimeout = err instanceof Error && err.message === 'timeout';
        return {
          role_id,
          decision: (isTimeout ? 'timeout' : 'error') as 'timeout' | 'error',
          confidence: null,
          rationale: isTimeout
            ? `Agent did not respond within ${timeout_ms}ms.`
            : `Error collecting claim: ${err instanceof Error ? err.message : String(err)}`,
          evidence: {
            persona_version: 0,
            persona_summary: '',
            skill_ids: [],
            experience_ids: [],
          },
          risks: [],
          availability: {
            agent_status: 'created' as const,
            loop_state: agent.getState(),
          },
          generated_at: nowTimestamp(),
        };
      }
    });

    const claims = await Promise.all(claimPromises);

    // 3. 按 role_id 排序
    claims.sort((a, b) => a.role_id.localeCompare(b.role_id));

    return {
      correlation_id,
      task_id: task.task_id ?? createId('task'),
      claims,
      started_at,
      completed_at: nowTimestamp(),
    };
  }

  /**
   * @deprecated 请使用 collectCompetitionClaims() + dispatchTask() 替代。
   * 旧 submitTask 内部委托给 collectCompetitionClaims + 按最高 confidence 选择 + executeTask。
   * 仅用于向后兼容，新代码不应使用。
   */
  async submitTask(request: AgentTaskRequest): Promise<SubmitTaskResult> {
    const batch = await this.collectCompetitionClaims(request);

    // 选择最高 confidence 的 participate Agent
    let bestRoleId: string | undefined;
    let bestConfidence = -1;
    for (const claim of batch.claims) {
      if (
        claim.decision === 'participate' &&
        claim.confidence !== null &&
        claim.confidence > bestConfidence
      ) {
        bestConfidence = claim.confidence;
        bestRoleId = claim.role_id;
      }
    }

    if (!bestRoleId) {
      throw new Error('No agent chose to participate');
    }

    const winner = this.agents.get(bestRoleId);
    if (!winner) {
      throw new Error(`Winner agent not found: ${bestRoleId}`);
    }

    const scores: Record<string, number> = {};
    for (const claim of batch.claims) {
      scores[claim.role_id] = claim.confidence ?? 0;
    }

    const cycle = await winner.executeTask(request);
    return { winner_role_id: bestRoleId, scores, cycle, status: 'completed' };
  }

  /**
   * 指定 Agent 执行任务（替代旧 submitTask 的指定派发方式）。
   *
   * 上层负责通过 collectCompetitionClaims 收集声明、比较并选择合适的 role_id，
   * 然后调用 dispatchTask 执行。
   *
   * 约束：
   * - 不包含 winner_role_id 和 scores
   * - 不存在、退役、draining 或正在忙的 Agent 明确返回 blocked
   * - 未调用 Driver 不会自动伪装为成功
   */
  async dispatchTask(role_id: string, task: AgentTaskRequest): Promise<DispatchTaskResult> {
    const agent = this.agents.get(role_id);
    if (!agent) {
      return {
        role_id,
        status: 'blocked',
        cycle: {
          agent_id: role_id,
          persona: await this.repository.getPersona(role_id).catch(() => ({
            role_id,
            version: 0,
            summary: '',
            skills_overview: '',
            experience_coverage: '',
            recent_performance: '',
            notes: '',
            generated_at: nowTimestamp(),
          })),
          skills_before: [],
          retrieval: { skills: [], experiences: [] },
          driver_context: {
            task_instruction: '',
            skills: [],
            experiences: [],
          },
          buffer_snapshot: {
            task_id: task.task_id ?? createId('task'),
            task_description: task.spec,
            driver_return: {
              artifacts: [],
              summary: 'Agent not found.',
              decisions: [],
              blockers: [],
              referenced_experiences: [],
              assumptions: [],
            },
            source_task_id: task.task_id ?? createId('task'),
            source_driver: task.source_driver ?? 'unknown',
            received_at: nowTimestamp(),
            retry_count: 0,
            extraction_status: 'pending',
          },
          buffer_seq: 0,
          extraction: {
            experiences: [],
            result: {
              experiences_created: 0,
              experiences_updated: 0,
              negative_experiences: 0,
              skills_promoted: 0,
            },
          },
          promotion: {
            check: {
              eligible: false,
              auto_approved: false,
              reasons: [],
              blocking_rules: ['Agent not found'],
            },
          },
        },
      };
    }

    const handle = await this.repository.getAgent(role_id).catch(() => null);
    if (handle && (handle.status === 'draining' || handle.status === 'retired')) {
      return {
        role_id,
        status: 'blocked',
        cycle: {
          agent_id: role_id,
          persona: await this.repository.getPersona(role_id).catch(() => ({
            role_id,
            version: 0,
            summary: '',
            skills_overview: '',
            experience_coverage: '',
            recent_performance: '',
            notes: '',
            generated_at: nowTimestamp(),
          })),
          skills_before: [],
          retrieval: { skills: [], experiences: [] },
          driver_context: { task_instruction: '', skills: [], experiences: [] },
          buffer_snapshot: {
            task_id: task.task_id ?? createId('task'),
            task_description: task.spec,
            driver_return: {
              artifacts: [],
              summary: `Agent status is ${handle.status}.`,
              decisions: [],
              blockers: [],
              referenced_experiences: [],
              assumptions: [],
            },
            source_task_id: task.task_id ?? createId('task'),
            source_driver: task.source_driver ?? 'unknown',
            received_at: nowTimestamp(),
            retry_count: 0,
            extraction_status: 'pending',
          },
          buffer_seq: 0,
          extraction: {
            experiences: [],
            result: {
              experiences_created: 0,
              experiences_updated: 0,
              negative_experiences: 0,
              skills_promoted: 0,
            },
          },
          promotion: {
            check: {
              eligible: false,
              auto_approved: false,
              reasons: [],
              blocking_rules: ['Agent not available'],
            },
          },
        },
      };
    }

    // 并发检查
    if (agent.hasPendingTask()) {
      return {
        role_id,
        status: 'blocked',
        cycle: {
          agent_id: role_id,
          persona: await this.repository.getPersona(role_id).catch(() => ({
            role_id,
            version: 0,
            summary: '',
            skills_overview: '',
            experience_coverage: '',
            recent_performance: '',
            notes: '',
            generated_at: nowTimestamp(),
          })),
          skills_before: [],
          retrieval: { skills: [], experiences: [] },
          driver_context: { task_instruction: '', skills: [], experiences: [] },
          buffer_snapshot: {
            task_id: task.task_id ?? createId('task'),
            task_description: task.spec,
            driver_return: {
              artifacts: [],
              summary: 'Agent is busy with another task.',
              decisions: [],
              blockers: [],
              referenced_experiences: [],
              assumptions: [],
            },
            source_task_id: task.task_id ?? createId('task'),
            source_driver: task.source_driver ?? 'unknown',
            received_at: nowTimestamp(),
            retry_count: 0,
            extraction_status: 'pending',
          },
          buffer_seq: 0,
          extraction: {
            experiences: [],
            result: {
              experiences_created: 0,
              experiences_updated: 0,
              negative_experiences: 0,
              skills_promoted: 0,
            },
          },
          promotion: {
            check: {
              eligible: false,
              auto_approved: false,
              reasons: [],
              blocking_rules: ['Agent busy'],
            },
          },
        },
      };
    }

    try {
      const cycle = await agent.executeTask(task);

      // 检测是否真的调用了 Driver：
      // 未调用 invoke_driver 时 writeToBuffer 使用占位 DriverReturn（所有数组为空且摘要含标记）
      const dr = cycle.buffer_snapshot.driver_return;
      const noDriverInvocation =
        dr.artifacts.length === 0 &&
        dr.decisions.length === 0 &&
        dr.blockers.length === 0 &&
        dr.referenced_experiences.length === 0 &&
        dr.assumptions.length === 0 &&
        dr.summary.includes('without driver invocation');

      if (noDriverInvocation) {
        return {
          role_id,
          status: 'no_driver_invocation',
          cycle,
        };
      }

      return {
        role_id,
        status: 'completed',
        cycle,
      };
    } catch (err) {
      return {
        role_id,
        status: 'failed',
        cycle: {
          agent_id: role_id,
          persona: await this.repository.getPersona(role_id).catch(() => ({
            role_id,
            version: 0,
            summary: '',
            skills_overview: '',
            experience_coverage: '',
            recent_performance: '',
            notes: '',
            generated_at: nowTimestamp(),
          })),
          skills_before: [],
          retrieval: { skills: [], experiences: [] },
          driver_context: { task_instruction: '', skills: [], experiences: [] },
          buffer_snapshot: {
            task_id: task.task_id ?? createId('task'),
            task_description: task.spec,
            driver_return: {
              artifacts: [],
              summary: `Task failed: ${err instanceof Error ? err.message : String(err)}`,
              decisions: [],
              blockers: [],
              referenced_experiences: [],
              assumptions: [],
            },
            source_task_id: task.task_id ?? createId('task'),
            source_driver: task.source_driver ?? 'unknown',
            received_at: nowTimestamp(),
            retry_count: 0,
            extraction_status: 'pending',
          },
          buffer_seq: 0,
          extraction: {
            experiences: [],
            result: {
              experiences_created: 0,
              experiences_updated: 0,
              negative_experiences: 0,
              skills_promoted: 0,
            },
          },
          promotion: {
            check: {
              eligible: false,
              auto_approved: false,
              reasons: [],
              blocking_rules: ['Task failed'],
            },
          },
        },
      };
    }
  }

  /**
   * 驱动所有正在运行（running）的 Agent 走一步循环。
   *
   * 应在外部调度循环中定期调用，例如：
   * ```ts
   * while (agents.some(a => a.getState() === 'running')) {
   *   await manager.tickAll();
   *   await sleep(100);
   * }
   * ```
   */
  async tickAll(): Promise<Map<string, AgentLoopTickResult>> {
    const results = new Map<string, AgentLoopTickResult>();
    for (const [role_id, agent] of this.agents) {
      if (agent.getState() === 'running') {
        results.set(role_id, await agent.runLoopTick());
      }
    }
    return results;
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
