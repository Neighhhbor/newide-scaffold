/**
 * Agent Loop 集成测试（真实 DeepSeek API）
 *
 * 验证端到端链路：
 *   AgentManager.submitTask
 *   → Agent 竞标 → assignTask
 *   → executeTask（内部 runLoopTick 循环）
 *     → LLM 调用 invoke_driver
 *     → Mock DriverHandler 返回符合契约的 DriverReturn
 *     → LLM 判断完成 → writeToBuffer
 *   → 返回 MemoryCycleResult
 *   → buffer 中有 pending 条目
 *
 * 需要 DEEPSEEK_API_KEY 环境变量（从 src/memory/.env 加载）。
 * 无 API key 时自动跳过。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { AgentManager } from '../../runtime/agent-manager';
import { InMemoryRepository } from '../../adapters/in-memory-repository';
import { InMemoryBufferRepository } from '../../adapters/in-memory-buffer-repository';
import { DeepSeekToolCallingClient } from '../../adapters/deepseek-tool-calling-client';
import { InvokeDriverTool } from '../../runtime/tools/invoke-driver-tool';
import type { DriverReturn } from '../../schemas';
import type { AgentTaskRequest } from '../../agent-types';

// ──────────────────────────────────────────────
// .env 加载
// ──────────────────────────────────────────────

/**
 * 手动解析 .env 文件（不含 dotenv 依赖）。
 * 从 src/memory/.env 加载 DEEPSEEK_API_KEY。
 */
function loadEnv(): void {
  const envPath = resolve(__dirname, '../../.env');
  if (!existsSync(envPath)) {
    return;
  }

  const content = readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();

    if (key === 'DEEPSEEK_API_KEY' && !process.env[key]) {
      process.env[key] = value;
    }
    if (key === 'DEEPSEEK_MODEL' && !process.env[key]) {
      process.env[key] = value;
    }
  }
}

// ──────────────────────────────────────────────
// 测试基础设施
// ──────────────────────────────────────────────

/** 创建一个符合 DriverReturnSchema 契约的 mock DriverReturn */
function createMockDriverReturn(): DriverReturn {
  return {
    artifacts: [
      {
        type: 'file',
        path: 'greeting.txt',
        summary: 'Created greeting.txt with "Hello Agent Loop"',
      },
    ],
    summary:
      'Successfully executed shell command: greeting.txt has been created with the expected content.',
    decisions: [
      {
        point: 'Output file creation',
        options: ['Use echo command', 'Use printf'],
        chosen: 'Use echo command',
        reason: 'Simplest approach for a single-line output',
      },
    ],
    blockers: [],
    referenced_experiences: [],
    assumptions: [
      {
        assumption: 'Target directory is writable',
        risk_if_wrong: 'File creation would fail with permission error',
      },
    ],
  };
}

// ──────────────────────────────────────────────
// 集成测试
// ──────────────────────────────────────────────

// 在 describe 之前加载 .env，确保 it.runIf 能正确评估
loadEnv();

const hasApiKey = !!process.env.DEEPSEEK_API_KEY;

describe('Agent loop integration (real DeepSeek API)', () => {
  if (!hasApiKey) {
    console.warn(
      '⚠ DEEPSEEK_API_KEY not set — integration test will be skipped. ' +
        'Set it in src/memory/.env or as an environment variable.',
    );
  }

  /**
   * 端到端集成测试：
   *
   * 1. 使用真实 DeepSeek API 作为顶层 Agent 的 LLM
   * 2. Agent 收到任务后通过 tool-calling 循环自主决策
   * 3. LLM 应自然调用 invoke_driver 工具来执行子任务
   * 4. Mock DriverHandler 返回符合契约的 DriverReturn
   * 5. LLM 看到 driver 返回成功 → 报告完成 → writeToBuffer
   */
  it.runIf(hasApiKey)(
    '应完成完整的 agent loop 周期：submitTask → LLM 决策 → invoke_driver → writeToBuffer',
    async () => {
      // ── 1. 存储层 ──
      const repository = new InMemoryRepository();
      const bufferRepository = new InMemoryBufferRepository();

      // ── 2. 真实 LLM 客户端 ──
      const llm = new DeepSeekToolCallingClient({
        model: process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',
      });

      // ── 3. Mock Driver ──
      //    记录被调用的次数和参数，供后续断言
      let driverCallCount = 0;
      let lastDriverInstruction = '';
      const mockDriverReturn = createMockDriverReturn();

      const driverTool = new InvokeDriverTool(async (task) => {
        driverCallCount++;
        lastDriverInstruction = task.instruction;
        return mockDriverReturn;
      });

      // ── 4. 自定义 System Prompt ──
      //    明确告诉 LLM 要用 invoke_driver 执行具体工作
      const systemPrompt = [
        'You are an Agent that dispatches work to a Driver Agent.',
        '',
        '## Available Tools',
        '- invoke_driver: Submit a sub-task to the Driver Agent for execution. Use this for ALL concrete work.',
        '- query_memory: Retrieve past experiences and skills (optional).',
        '',
        '## Workflow',
        '1. Analyze the task.',
        '2. Call invoke_driver with a clear instruction to execute the work.',
        "3. Review the driver's structured result (artifacts, summary, decisions, blockers).",
        '4. If the driver completed the work successfully, summarize the result and include "[done]" in your response.',
        '',
        '## Important',
        '- Always use invoke_driver for any execution work — do not try to do it yourself.',
        '- The driver will return a structured report. Read it and confirm the task is done.',
      ].join('\n');

      // ── 5. AgentManager ──
      const manager = await AgentManager.create(repository, bufferRepository, {
        tools: {
          llm,
          tools: [driverTool],
          systemPrompt,
          maxToolCalls: 10,
        },
      });

      await manager.createAgent({
        role_id: 'role_integration_test',
        name: 'Integration Test Agent',
        tags: [],
      });

      // dispatchTask 即可，无需 start()

      // ── 6. 提交简单任务 ──
      //     任务应该足够简单，让 LLM 自然决定调用 invoke_driver
      const task: AgentTaskRequest = {
        spec:
          'Execute a shell command to create a greeting file. ' +
          "Use invoke_driver to run: echo 'Hello Agent Loop' > greeting.txt",
        task_id: 'task_integration_001',
        call_id: 'call_integration_001',
        source_driver: 'test-driver',
      };

      const result = await manager.dispatchTask('role_integration_test', task);

      // ── 7. 断言 ──

      // 7a. 任务状态
      expect(result.status).toBe('completed');
      expect(result.role_id).toBe('role_integration_test');

      // 7b. LLM 实际调用了 invoke_driver
      expect(driverCallCount).toBeGreaterThanOrEqual(1);
      expect(lastDriverInstruction).toContain('greeting');

      // 7c. MemoryCycleResult 的 agent_id 正确
      expect(result.cycle.agent_id).toBe('role_integration_test');
      expect(result.cycle.buffer_snapshot.task_id).toBe('task_integration_001');

      // 7d. Buffer snapshot 中的 driver_return 与 mock DriverReturn 一致
      const snapshotDriverReturn = result.cycle.buffer_snapshot.driver_return;
      expect(snapshotDriverReturn.summary).toBe(mockDriverReturn.summary);
      expect(snapshotDriverReturn.artifacts).toEqual(mockDriverReturn.artifacts);
      expect(snapshotDriverReturn.decisions).toEqual(mockDriverReturn.decisions);
      expect(snapshotDriverReturn.blockers).toEqual(mockDriverReturn.blockers);
      expect(snapshotDriverReturn.referenced_experiences).toEqual(
        mockDriverReturn.referenced_experiences,
      );
      expect(snapshotDriverReturn.assumptions).toEqual(mockDriverReturn.assumptions);

      // 7e. 提取和晋升未被同步执行（由离线 Processor 处理）
      expect(result.cycle.extraction.result.experiences_created).toBe(0);
      expect(result.cycle.extraction.result.skills_promoted).toBe(0);

      // 7f. Buffer 中有一条 pending 记录
      const meta = await bufferRepository.getBufferMeta('role_integration_test');
      expect(meta.pending_count).toBe(1);

      // 7g. Agent 已回到 sleeping 状态
      const agent = manager.getAgent('role_integration_test')!;
      expect(agent.getState()).toBe('sleeping');
      expect(agent.hasPendingTask()).toBe(false);
    },
    120_000, // 超时：真实 API 调用需要更长时间（120 秒）
  );
});
