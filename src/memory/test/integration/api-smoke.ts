/**
 * LiteLLM 真实 API 冒烟测试
 *
 * 逐个调用 adapter 的真实 API，验证：
 *   1. LiteLLMClientAdapter 基础通信
 *   2. LlmTaskInstructionPlanner 任务规划
 *   3. LlmContextCleaner 上下文清理
 *   4. LlmExperienceExtractor 经验提取
 *   5. LlmSkillPromotion 技能晋升
 *
 * 运行：npx tsx test/integration/api-smoke.ts
 *
 * ⚠️  需要 OPENAI_API_KEY 环境变量（或对应 provider 的 API key）
 *    export OPENAI_API_KEY=sk-xxx
 *     或项目根目录有 .env 文件
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// 手动加载 .env（项目没装 dotenv 包）
function loadDotenv(): void {
  const envPath = resolve(import.meta.dirname, '../../.env');
  try {
    const content = readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {
    // .env 不存在不影响
  }
}
loadDotenv();

import { LiteLLMClientAdapter } from '../../adapters/litellm-client-adapter';
import { LlmContextCleaner } from '../../adapters/context-cleaner';
import { LlmExperienceExtractor } from '../../adapters/llm-experience-extractor';
import { LlmSkillPromotion } from '../../adapters/llm-skill-promotion';
import { InMemoryRepository } from '../../adapters/in-memory-repository';
import { InMemoryBufferRepository } from '../../adapters/in-memory-buffer-repository';
import { createAgentMemoryScope } from '../../adapters/agent-memory-scope';
import type { DriverReturn, BufferSnapshot, ExperienceRecord } from '../../schemas';

// ────────────────────────────────────────────────────
//  1. 检查环境变量（兼容 LLM_PROVIDER=deepseek 配置）
// ────────────────────────────────────────────────────
if (process.env.LLM_PROVIDER === 'deepseek' && process.env.DEEPSEEK_API_KEY) {
  if (!process.env.OPENAI_API_KEY) process.env.OPENAI_API_KEY = process.env.DEEPSEEK_API_KEY;
  if (!process.env.OPENAI_BASE_URL) process.env.OPENAI_BASE_URL = 'https://api.deepseek.com/v1';
}

if (!process.env.OPENAI_API_KEY) {
  console.error(
    '❌ 未找到 API key。请在 src/memory/.env 中设置 DEEPSEEK_API_KEY 或 OPENAI_API_KEY',
  );
  process.exit(1);
}

(async () => {
  // ── 1. 基础通信测试 ──
  console.log('\n═══ 1. LiteLLMClientAdapter 基础通信 ═══');
  const client = new LiteLLMClientAdapter();
  try {
    const result = await client.complete({
      messages: [
        { role: 'system', content: 'You are a helpful assistant. Reply in one short sentence.' },
        { role: 'user', content: 'Say "hello world" exactly.' },
      ],
    });
    console.log(`  ✅ 通信成功: "${result.trim()}"`);
  } catch (e) {
    console.error(`  ❌ 通信失败:`, (e as Error).message);
    throw e;
  }

  // ── 3. LlmContextCleaner 测试 ──
  console.log('\n═══ 3. LlmContextCleaner 上下文清理 ═══');
  const cleaner = new LlmContextCleaner(client);
  try {
    const snapshot = await cleaner.clean({
      agent_id: 'agent_smoke',
      source_task_id: 'task_smoke_001',
      raw_context: `Agent was tasked with implementing JWT authentication.
Considered two approaches: session-based auth and JWT tokens.
Chose JWT for better scalability in a distributed system.
Planned steps: 1) Add JWT dependency, 2) Create auth middleware,
3) Implement login endpoint, 4) Add refresh token rotation.`,
      driver_returns: [
        {
          call_id: 'call_001',
          driver_id: 'mock-driver',
          driver_return: {
            summary: 'Successfully implemented JWT auth flow',
            decisions: [
              {
                point: 'Auth method',
                options: ['JWT', 'sessions'],
                chosen: 'JWT',
                reason: 'more scalable',
              },
            ],
            blockers: [],
            artifacts: [
              {
                type: 'code' as const,
                path: 'src/middleware/auth.ts',
                summary: 'JWT auth middleware',
              },
            ],
            referenced_experiences: [],
            assumptions: [],
          } satisfies DriverReturn,
        },
      ],
    });
    if (snapshot) {
      console.log(`  ✅ 清理成功`);
      console.log(`  thinking_trace: ${snapshot.thinking_trace.substring(0, 100)}...`);
      console.log(`  planning_trace: ${snapshot.planning_trace.substring(0, 100)}...`);
      console.log(`  压缩比: ${(snapshot.compression_ratio * 100).toFixed(1)}%`);
    } else {
      console.log(`  ⚠️  清理返回 null（降级行为）`);
    }
  } catch (e) {
    console.error(`  ❌ 清理异常:`, (e as Error).message);
    throw e;
  }

  // ── 4. LlmExperienceExtractor 测试 ──
  console.log('\n═══ 4. LlmExperienceExtractor 经验提取 ═══');
  const extractor = new LlmExperienceExtractor(client);
  try {
    const bufferSnapshot: BufferSnapshot = {
      task_id: 'task_smoke_002',
      task_description: 'Implement JWT authentication with refresh token rotation',
      source_task_id: 'task_smoke_002',
      source_driver: 'mock-driver',
      received_at: new Date().toISOString(),
      retry_count: 0,
      extraction_status: 'pending',
      driver_return: {
        summary: 'Successfully implemented JWT authentication',
        decisions: [
          {
            point: 'Auth method',
            options: ['JWT', 'sessions'],
            chosen: 'JWT',
            reason: 'more scalable for distributed systems',
          },
        ],
        blockers: [],
        assumptions: [
          {
            assumption: 'Token refresh window is 7 days',
            risk_if_wrong: 'Users may need to re-login during long sessions',
          },
        ],
        referenced_experiences: [],
        artifacts: [
          { type: 'code', path: 'src/middleware/auth.ts', summary: 'JWT auth middleware' },
        ],
      },
    };
    const result = await extractor.extract(bufferSnapshot);
    console.log(`  ✅ 提取成功，获得 ${result.experiences.length} 条经验`);
    for (const exp of result.experiences) {
      console.log(`    - [${exp.type}] ${exp.description} (confidence: ${exp.confidence})`);
    }
  } catch (e) {
    console.error(`  ❌ 提取异常:`, (e as Error).message);
    throw e;
  }

  // ── 5. LlmSkillPromotion 测试 ──
  console.log('\n═══ 5. LlmSkillPromotion 技能晋升 ═══');
  const promoter = new LlmSkillPromotion(client);
  const repo = new InMemoryRepository();
  const bufRepo = new InMemoryBufferRepository();
  await repo.initializeAgent({ role_id: 'role_smoke', name: 'Smoke Agent', tags: ['test'] });
  await bufRepo.ensureAgent('role_smoke');
  const memory = createAgentMemoryScope(repo, bufRepo, 'role_smoke');

  const now = new Date().toISOString();
  const candidateExp: ExperienceRecord = {
    id: 'exp-smoke-001',
    description: 'Use JWT with refresh token rotation for scalable auth',
    description_embedding: [0.1, 0.2, 0.3],
    content:
      'JWT authentication proved more reliable than session-based approach. Implemented token refresh and rotation for enhanced security.',
    confidence: 0.97,
    tags: ['auth', 'jwt'],
    agent_id: 'role_smoke',
    confidence_history: [
      { value: 0.85, updated_at: now, reason: 'initial' },
      { value: 0.97, updated_at: now, reason: 'confirmed by task outcome' },
    ],
    referenced_count: 0,
    source_task_id: 'task_smoke_001',
    source_driver: 'mock-driver',
    type: 'positive',
    created_at: now,
    updated_at: now,
  };
  await repo.saveExperience('role_smoke', candidateExp);

  try {
    const outcome = await promoter.promote(
      memory,
      { spec: 'Implement auth', task_id: 'task_smoke_001' },
      [candidateExp],
    );
    if (outcome.check.eligible && outcome.skill) {
      console.log(`  ✅ 晋升成功`);
      console.log(`  description: ${outcome.skill.description}`);
      console.log(`  content: ${outcome.skill.content.substring(0, 100)}...`);
      console.log(`  tags: ${outcome.skill.tags.join(', ')}`);
    } else {
      console.log(`  ⚠️  晋升未触发（eligible=${outcome.check.eligible}）`);
    }
  } catch (e) {
    console.error(`  ❌ 晋升异常:`, (e as Error).message);
    throw e;
  }

  // ── 汇总 ──
  console.log('\n═══════════════════════════════════════');
  console.log('✅ 所有 API 冒烟测试通过');
  console.log('═══════════════════════════════════════');
})().catch((e) => {
  console.error('\n❌ 冒烟测试失败:', e);
  process.exit(1);
});
