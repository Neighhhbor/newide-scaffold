/**
 * Memory 端到端演示 — dispatch 版本
 *
 * 展示完整流程：
 *   多 Agent 自评 → collectCompetitionClaims（只返回参选者）
 *   → 外部选 Agent → dispatchTask（真实 LLM + mock InvokeDriverTool）
 *   → extractBuffer（真实 LLM 提取）
 *   → promoteExperiences（真实 LLM 晋升）
 *
 * 运行：npx tsx src/memory/mvp/memory-demo.ts
 */
import { AgentManager } from '../runtime/agent-manager';
import { InMemoryRepository } from '../adapters/in-memory-repository';
import { InMemoryBufferRepository } from '../adapters/in-memory-buffer-repository';
import { createAgentMemoryScope } from '../adapters/agent-memory-scope';
import { extractBufferForAgent, promoteExperiencesForAgent } from '../services/memory-cycle';
import { LiteLLMClientAdapter } from '../adapters/litellm-client-adapter';
import { DeepSeekToolCallingClient } from '../adapters/deepseek-tool-calling-client';
import { InvokeDriverTool } from '../runtime/tools/invoke-driver-tool';
import type { DriverReturn } from '../schemas';

// ═══════════════════════════════════════
// 真实 LLM
// ═══════════════════════════════════════

const llmClient = new LiteLLMClientAdapter();
const toolLlm = new DeepSeekToolCallingClient();

const mockDriverReturn: DriverReturn = {
  summary: '成功修复登录页面 CSS 布局问题',
  artifacts: [
    { type: 'file', path: 'src/pages/Login.css', summary: '新增移动端响应式样式' },
    { type: 'file', path: 'src/pages/Login.tsx', summary: '调整表单容器结构为 Flexbox' },
  ],
  decisions: [
    {
      point: '布局方案选择',
      options: ['Flexbox', 'CSS Grid', 'float'],
      chosen: 'Flexbox',
      reason: '兼容性好，一维布局更适合表单场景',
    },
    {
      point: '移动端适配策略',
      options: ['media query', 'rem 单位', 'viewport 单位'],
      chosen: 'media query + rem 混合',
      reason: '兼顾精细控制与可维护性',
    },
  ],
  blockers: [],
  referenced_experiences: [],
  assumptions: [
    {
      assumption: '目标浏览器支持 Flexbox',
      risk_if_wrong: '需添加 autoprefixer 或回退方案',
    },
  ],
};

// ═══════════════════════════════════════
// 主流程
// ═══════════════════════════════════════

async function main(): Promise<void> {
  const repository = new InMemoryRepository();
  const bufferRepository = new InMemoryBufferRepository();

  // Manager 使用 LiteLLMClientAdapter（同时支持 LlmClient + ToolCallingClient）
  const manager = await AgentManager.create(repository, bufferRepository, {
    tools: {
      llm: toolLlm,
      tools: [new InvokeDriverTool(async () => mockDriverReturn)],
    },
  });

  // ── Step 1: 创建多个 Agent ──
  console.log('=== 1. 创建多个 Agent ===');
  const agents = [
    {
      role_id: 'role_fe',
      name: '前端工程师',
      persona_seed: '擅长 CSS/React 布局',
      tags: ['css', 'react'],
    },
    {
      role_id: 'role_be',
      name: '后端工程师',
      persona_seed: '擅长 API/数据库设计',
      tags: ['node', 'sql'],
    },
    {
      role_id: 'role_ops',
      name: '运维工程师',
      persona_seed: '擅长部署/监控',
      tags: ['docker', 'k8s'],
    },
  ];
  for (const spec of agents) {
    const handle = await manager.createAgent(spec);
    console.log(`  ✅ ${handle.role_id} (${handle.name})`);
  }

  // ── Step 2: 竞标收集 ──
  const task = {
    spec: '修复登录页面的 CSS 布局问题。按钮错位，移动端表单宽度异常。',
    task_id: 'task_demo_001',
    call_id: 'call_demo_001',
    source_driver: 'code-driver',
  };

  console.log('\n=== 2. Agent 自评 — collectCompetitionClaims ===');
  console.log(`  任务: ${task.spec}`);
  const batch = await manager.collectCompetitionClaims(task);
  console.log(`  参选 Agent: ${batch.claims.length} 个`);
  for (const claim of batch.claims) {
    console.log(`  ✅ ${claim.role_id} — 愿意参与`);
  }

  if (batch.claims.length === 0) {
    console.log('  ❌ 无 Agent 参选，退出');
    return;
  }

  // ── Step 3: 派发 ──
  const winner = batch.claims[0]!;
  console.log(`\n=== 3. 派发给 ${winner.role_id} — dispatchTask ===`);

  const dispatchResult = await manager.dispatchTask(winner.role_id, task);
  console.log(`  状态: ${dispatchResult.status}`);
  console.log(`  buffer 序号: ${dispatchResult.cycle.buffer_seq}`);

  // 打印 mock driver 返回的报告
  console.log('\n  ── Mock Driver 返回 ──');
  const dr = dispatchResult.cycle.buffer_snapshot.driver_return;
  console.log(`  摘要: ${dr.summary}`);
  console.log(`  产出: ${dr.artifacts.map((a: { path: string }) => a.path).join(', ')}`);
  console.log(`  决策:`);
  for (const d of dr.decisions) {
    console.log(`    • ${d.point} → ${d.chosen}（${d.reason}）`);
  }

  // ── Step 4: 主动 LLM 提取 + 晋升（分两步）──
  console.log('\n=== 4. 主动提取 + 晋升 ===');

  const memory = createAgentMemoryScope(repository, bufferRepository, winner.role_id);

  // dispatchTask 返回的 buffer 已包含完整的 mockDriverReturn
  // 直接用它的 seq 进行提取和晋升
  const seq = dispatchResult.cycle.buffer_seq;

  // 4a. 仅提取（使用 extractBufferForAgent — 传 role_id 即可）
  console.log('\n  ── 4a. extractBufferForAgent ──');
  console.log('  >> 输入: buffer snapshot (driver_return)');
  console.log(`     summary: ${dr.summary}`);
  console.log(`     decisions: ${JSON.stringify(dr.decisions, null, 4)}`);
  console.log(`     artifacts: ${JSON.stringify(dr.artifacts, null, 4)}`);

  const extraction = await extractBufferForAgent(
    winner.role_id,
    seq,
    repository,
    bufferRepository,
    llmClient,
  );

  console.log(`  << 输出: ExtractionOutput`);
  console.log(`     experiences_created: ${extraction.result.experiences_created}`);
  console.log(`     experiences_updated: ${extraction.result.experiences_updated}`);
  for (const exp of extraction.experiences) {
    const icon = exp.type === 'positive' ? '📗' : '📕';
    console.log(`  ${icon} [${exp.type}]`);
    console.log(`     id:            ${exp.id}`);
    console.log(`     description:   ${exp.description}`);
    console.log(`     confidence:    ${exp.confidence}`);
    console.log(`     tags:          ${exp.tags.join(', ')}`);
    console.log(`     content:       ${exp.content.substring(0, 160)}`);
    if (exp.linked_negative_exp?.length) {
      console.log(`     linked_neg:    ${exp.linked_negative_exp.join(', ')}`);
    }
  }

  // 4b. 仅晋升（使用 promoteExperiencesForAgent — 传 role_id 即可）
  console.log('\n  ── 4b. promoteExperiencesForAgent ──');

  // 打印晋升函数的输入：repo 中 eligible 的经验
  const allExp = await memory.listExperiences();
  const eligible = allExp.filter(
    (e: { type: string; confidence: number; promoted_to?: unknown }) =>
      e.type === 'positive' && e.confidence > 0.95 && !e.promoted_to,
  );
  const notEligible = allExp.filter(
    (e: { type: string; confidence: number; promoted_to?: unknown }) =>
      !(e.type === 'positive' && e.confidence > 0.95 && !e.promoted_to),
  );
  console.log('  >> 输入: repo 经验列表');
  console.log(`     总经验: ${allExp.length}`);
  console.log(`     eligible（confidence>0.95 且未晋升）: ${eligible.length}`);
  if (notEligible.length > 0) {
    console.log(`     未通过筛选:`);
    for (const e of notEligible) {
      const reasons: string[] = [];
      if (e.type !== 'positive') reasons.push(`type=${e.type}`);
      if (e.confidence <= 0.95) reasons.push(`confidence=${e.confidence}`);
      if (e.promoted_to) reasons.push(`已晋升`);
      console.log(`       - "${e.description}" → ${reasons.join(', ')}`);
    }
  }

  const outcomes = await promoteExperiencesForAgent(
    winner.role_id,
    repository,
    bufferRepository,
    llmClient,
  );

  console.log(`  << 输出: ${outcomes.length} 个 PromotionOutcome`);
  for (const o of outcomes) {
    console.log(`     eligible: ${o.check.eligible}`);
    console.log(`     auto_approved: ${o.check.auto_approved}`);
    console.log(`     reasons: ${o.check.reasons.join('; ')}`);
    if (o.skill) {
      console.log(`     🏆 skill: 「${o.skill.description}」`);
      console.log(`        id:    ${o.skill.id}`);
      console.log(`        tags:  ${o.skill.tags.join(', ')}`);
      console.log(`        content: ${o.skill.content.substring(0, 160)}`);
    }
  }

  // ── Step 5: 验证存储 ──
  console.log('\n=== 5. 存储状态 ===');
  const experiences = await repository.listExperiences(winner.role_id);
  const skills = await repository.listSkills(winner.role_id);
  const meta = await bufferRepository.getBufferMeta(winner.role_id);
  console.log(`  经验: ${experiences.length} 条`);
  console.log(`  技能: ${skills.length} 个`);
  console.log(`  buffer: ${meta.total_processed} 已处理, ${meta.pending_count} 待处理`);

  console.log('\n=== ✅ 完成 ===');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
