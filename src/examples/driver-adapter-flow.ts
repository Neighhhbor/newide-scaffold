/**
 * DriverAdapter Integration Example
 *
 * 演示 DriverAdapter 如何接入 Agent Memory 工作流：
 *   createDriverAdapterDeps → AgentManager → Agent.runOnce → 完整记忆周期
 *
 * ## 运行方式
 *
 * ```bash
 * # 档位 1: MockDriver 跑通（无需任何外部依赖）
 * pnpm example:driver-adapter
 *
 * # 档位 2: 指定自定义 prompt
 * pnpm example:driver-adapter "Fix the SQL injection in auth.ts"
 *
 * # 档位 3: 启用 LLM 提取（需要 DEEPSEEK_API_KEY）
 * DEEPSEEK_API_KEY=sk-xxx pnpm example:driver-adapter --llm
 *
 * # 档位 4: 接入真实外部 Driver（gemini ACP）
 * pnpm example:driver-adapter --external-driver gemini "Add error handling to login"
 * ```
 *
 * ## 与 integration-v0 的区别
 *
 * integration-v0 走的是 Coordinator 高层编排（A-B-C-D 全链路），
 * 本例走的是 Memory 模块自有工作流（A-B 链路），专注验证 DriverAdapter
 * 在 Agent 记忆周期中的表现：Context 序列化 → Driver 调用 → 结果提取 → 经验累积。
 */
import { InMemoryRepository } from '../memory/adapters/in-memory-repository';
import { InMemoryBufferRepository } from '../memory/adapters/in-memory-buffer-repository';
import { AgentManager, toMemoryTaskProjection } from '../memory/runtime/agent-manager';
import { createDriverAdapterDeps } from '../memory/mvp/default-driver-adapter-deps';
import { MockDriver } from '../driver';

// ═══════════════════════════════════════════════════════════════
// CLI 参数解析
// ═══════════════════════════════════════════════════════════════

const args = process.argv.slice(2);
const useLlm = args.includes('--llm');
const useExternalDriver = args.includes('--external-driver');
const externalDriverCommand = useExternalDriver
  ? (args[args.indexOf('--external-driver') + 1] ?? 'gemini')
  : undefined;

const customPrompt = args.find((arg) => !arg.startsWith('--') && arg !== externalDriverCommand);
const taskPrompt =
  customPrompt ??
  'Write a function to validate email addresses using regex. Return the implementation.';

console.log('🔌 DriverAdapter Integration Example\n');
console.log(`Mode: ${useLlm ? 'LLM enhanced' : 'heuristic (default)'}`);
console.log(`Driver: ${useExternalDriver ? `external (${externalDriverCommand})` : 'MockDriver'}`);
console.log(`Prompt: "${taskPrompt}"\n`);

// ═══════════════════════════════════════════════════════════════
// 构造 deps
// ═══════════════════════════════════════════════════════════════

const deps = useExternalDriver
  ? createDriverAdapterDeps({
      driverCommand: externalDriverCommand!,
      driverArgs: ['acp'],
      driverTimeoutMs: 300_000,
      ...(useLlm
        ? {
            llmOptions: {},
            useLlmResultMapping: true,
          }
        : {}),
    })
  : createDriverAdapterDeps({
      // MockDriver 模式：手动传入 MockDriver 实例作为 customDriverRuntime
      customDriverRuntime: new MockDriver(),
      ...(useLlm
        ? {
            llmOptions: {},
            useLlmResultMapping: true,
          }
        : {}),
      driverCommand: 'mock', // 占位（customDriverRuntime 优先）
    });

// ═══════════════════════════════════════════════════════════════
// 创建 AgentManager 并注册 Agent
// ═══════════════════════════════════════════════════════════════

const repo = new InMemoryRepository();
const bufRepo = new InMemoryBufferRepository();

const manager = AgentManager.create(repo, bufRepo, { deps });

const agentHandle = await manager.createAgent({
  role_id: 'demo-agent',
  persona: {
    name: 'Demo Agent',
    role: 'software engineer',
    description: 'An agent that learns from its own experiences.',
  },
});

console.log(`Created agent: ${agentHandle.role_id}`);
console.log(`Persona: ${agentHandle.persona.role} — ${agentHandle.persona.description}\n`);

// ═══════════════════════════════════════════════════════════════
// 提交任务
// ═══════════════════════════════════════════════════════════════

console.log('━'.repeat(60));
console.log('📤 Submitting task...\n');

const result = await manager.submitTask({
  task_id: 'demo-task-1',
  call_id: 'demo-call-1',
  source_driver: useExternalDriver ? externalDriverCommand! : 'mock-driver',
  spec: taskPrompt,
});

// ═══════════════════════════════════════════════════════════════
// 输出结果
// ═══════════════════════════════════════════════════════════════

const { cycle } = result;
const projection = toMemoryTaskProjection(result);

console.log('━'.repeat(60));
console.log('📋 Task Result\n');

console.log(`  Winner:     ${projection.winner_role_id}`);
console.log(`  Driver:     ${cycle.buffer_snapshot.source_driver}`);
console.log(`  Status:     ${cycle.buffer_snapshot.driver_return.summary.slice(0, 120)}...`);

console.log('\n  ── Context ──');
console.log(`  Skills used:     ${projection.context.skill_count}`);
console.log(`  Experiences ref: ${projection.context.experience_count}`);

console.log('\n  ── Driver Output ──');
const dr = cycle.buffer_snapshot.driver_return;
console.log(`  Artifacts:       ${dr.artifacts.length}`);
for (const art of dr.artifacts.slice(0, 5)) {
  console.log(`    - [${art.type}] ${art.path}`);
  if (art.summary) console.log(`      ${art.summary}`);
}
console.log(`  Decisions:       ${dr.decisions.length}`);
for (const dec of dr.decisions.slice(0, 3)) {
  console.log(`    - ${dec.point} → ${dec.chosen}`);
}
console.log(`  Blockers:        ${dr.blockers.length}`);
for (const blk of dr.blockers.slice(0, 3)) {
  console.log(`    - ${blk.blocker} (resolved: ${blk.resolved})`);
}
console.log(`  Assumptions:     ${dr.assumptions.length}`);
for (const asm of dr.assumptions.slice(0, 3)) {
  console.log(`    - ${asm.assumption}`);
}

console.log('\n  ── Extraction ──');
console.log(`  New experiences:   ${projection.extraction.experiences_created}`);
console.log(`  Updated:           ${projection.extraction.experiences_updated}`);
console.log(`  Negative:          ${projection.extraction.negative_experiences}`);
console.log(`  Skills promoted:   ${projection.extraction.skills_promoted}`);

if (projection.promoted_skill_ids.length > 0) {
  console.log(`  Promoted skills:   ${projection.promoted_skill_ids.join(', ')}`);
}

console.log(`\n  Buffer seq: ${projection.buffer_seq}`);

// 验证：确认 Adapter 确实在工作
console.log('\n━'.repeat(60));
console.log('✅ Verification\n');
console.log(`  DriverReturn has 6 fields: ${verifyDriverReturnFields(dr) ? 'PASS' : 'FAIL'}`);
console.log(
  `  Buffer contains driver_return: ${cycle.buffer_snapshot.driver_return.summary.length > 0 ? 'PASS' : 'FAIL'}`,
);
console.log(
  `  Experiences stored: ${(await repo.listExperiences(agentHandle.role_id)).length > 0 ? 'PASS' : 'FAIL'}`,
);

console.log('\n✨ DriverAdapter integration verified!');

// ═══════════════════════════════════════════════════════════════
// Helper
// ═══════════════════════════════════════════════════════════════

function verifyDriverReturnFields(dr: typeof cycle.buffer_snapshot.driver_return): boolean {
  const required = [
    'artifacts',
    'summary',
    'decisions',
    'blockers',
    'referenced_experiences',
    'assumptions',
  ] as const;
  return required.every((key) => {
    const val = dr[key];
    if (key === 'summary') return typeof val === 'string' && val.length > 0;
    return Array.isArray(val);
  });
}
