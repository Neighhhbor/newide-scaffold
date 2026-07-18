/**
 * Driver Adapter Flow — 接通 B→A 方向 Driver 适配桥的完整 Demo
 *
 * 演示如何使用 DriverBridge 将方向 A 的 DriverRuntimeHandle
 * 封装为方向 B 的 InvokeDriverTool 的 DriverHandler。
 *
 * 执行流程：
 * 1. 创建方向 A 的 Driver（MockDriver 或 ExternalDriverRuntime）
 * 2. 通过 DriverBridge 创建 DriverHandler
 * 3. 创建 InvokeDriverTool（注入 handler）
 * 4. 模拟顶层 Agent LLM 调用 invoke_driver
 * 5. 输出六字段报告
 *
 * Usage:
 *   # 默认：MockDriver
 *   pnpm example:driver-adapter
 *
 *   # 自定义 prompt
 *   pnpm example:driver-adapter "Fix the TypeScript build errors in the project"
 *
 *   # 使用外部 ACP Driver（需先进入 ACP_DRIVER_RUNNER_DIR 执行 build）
 *   ACP_DRIVER_RUNNER_DIR=/path/to/acp-client-prototype pnpm example:driver-adapter --external-driver
 *
 *   # 外部 Driver + 自定义 prompt
 *   ACP_DRIVER_RUNNER_DIR=/path/to/acp-client-prototype pnpm example:driver-adapter --external-driver "Add user auth"
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { MockDriver } from '../driver/mock-driver';
import { ExternalDriverRuntime } from '../driver/external-driver-runtime';
import { CommandDriverTransport } from '../driver/command-driver-transport';
import { DriverBridge, type DriverBridgeOptions } from '../driver/driver-bridge';
import { InvokeDriverTool } from '../memory/runtime/tools/invoke-driver-tool';
import type { DriverRuntimeHandle } from '../driver';
import type { DriverReturn } from '../memory/schemas';

/** Claude 模型相关的环境变量，传给子进程时需显式清除 */
const CLAUDE_MODEL_OVERRIDE_ENV = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
] as const;

// ── 解析命令行参数 ──
const args = process.argv.slice(2);
const useExternalDriver = args.includes('--external-driver');
const customPrompt = args.find((arg) => !arg.startsWith('--'));
const driverPrompt = customPrompt || 'Produce a mock patch artifact for the B-to-A bridge demo';

console.log('🚀 Driver Adapter Flow (B→A Bridge Demo)\n');
console.log(`Driver: ${useExternalDriver ? 'external (ACP)' : 'mock'}`);
console.log(`Prompt: "${driverPrompt}"\n`);

// ── 1. 创建方向 A 的 Driver ──
let driver: DriverRuntimeHandle;

if (useExternalDriver) {
  const driverRunnerDir = process.env.ACP_DRIVER_RUNNER_DIR;

  if (!driverRunnerDir) {
    console.error(
      '❌ Error: ACP_DRIVER_RUNNER_DIR environment variable is required when using --external-driver.\n',
    );
    console.error('Example:');
    console.error(
      '  ACP_DRIVER_RUNNER_DIR=/path/to/acp-client-prototype pnpm example:driver-adapter --external-driver\n',
    );
    process.exit(1);
  }

  const driverEntrypoint = path.join(driverRunnerDir, 'dist/src/driver/contract-runner.js');
  if (!existsSync(driverEntrypoint)) {
    console.error(`❌ Error: Driver entrypoint not found: ${driverEntrypoint}\n`);
    console.error('Please build the ACP driver first:');
    console.error(`  cd ${driverRunnerDir} && pnpm run build\n`);
    process.exit(1);
  }

  console.log(`Using external driver from: ${driverRunnerDir}`);
  console.log(`ACP_AGENT_ID: ${process.env.ACP_AGENT_ID || 'mock-driver'}`);
  console.log(`ACP_WORKSPACE: ${process.env.ACP_WORKSPACE || process.cwd()}`);

  const driverEnvFile = process.env.ACP_DRIVER_ENV_FILE || path.join(driverRunnerDir, '.env');
  const driverEnv = loadEnvFile(driverEnvFile);
  const unsetEnv = CLAUDE_MODEL_OVERRIDE_ENV.filter((key) => driverEnv[key] === undefined);
  if (Object.keys(driverEnv).length > 0) {
    console.log(`ACP_DRIVER_ENV_FILE: ${driverEnvFile}`);
  }
  console.log('');

  const driverTimeoutMs = process.env.ACP_DRIVER_TIMEOUT_MS
    ? parseInt(process.env.ACP_DRIVER_TIMEOUT_MS, 10)
    : 120_000;

  driver = new ExternalDriverRuntime({
    driver_id: 'acp-external',
    transport: new CommandDriverTransport({
      command: 'node',
      args: [driverEntrypoint],
      cwd: driverRunnerDir,
      env: {
        ...driverEnv,
        ACP_AGENT_ID: process.env.ACP_AGENT_ID || 'mock-driver',
        ACP_WORKSPACE: process.env.ACP_WORKSPACE || process.cwd(),
      },
      unsetEnv,
      timeoutMs: driverTimeoutMs,
    }),
  });
} else {
  driver = new MockDriver();
}

// ── 2. 创建 DriverBridge ──
const bridgeOptions: DriverBridgeOptions = {
  driver,
  loadTranscript: false, // 无 transcript 时用元数据构造
};

const bridge = new DriverBridge(bridgeOptions);

console.log(`Bridge created: Direction B → Direction A`);
console.log(`  Driver: ${driver.driver_id}`);
console.log(`  Session: ${driver.session_id}`);
console.log('');

// ── 3. 创建 InvokeDriverTool ──
const driverTool = new InvokeDriverTool(bridge.createHandler());

// ── 4. 模拟顶层 Agent LLM 调用 ──
async function main(): Promise<void> {
  console.log('📤 Sending task to Driver...\n');

  try {
    console.log('[driver-adapter-flow] calling driverTool.execute...');
    const executeStart = Date.now();

    const driverReturn: DriverReturn = await driverTool.execute({
      instruction: driverPrompt,
      context: {
        skills: [
          'TypeScript project structure: src/driver/, src/memory/, src/coordinator/',
          'The DriverRuntimeHandle interface uses sendPrompt() to execute tasks',
        ],
        experiences: ['Previous MockDriver invocations produced patch artifacts successfully'],
      },
    });

    const executeElapsed = Date.now() - executeStart;
    console.log(`[driver-adapter-flow] driverTool.execute resolved after ${executeElapsed}ms`);

    // ── 5. 输出六字段报告 ──
    console.log('✅ Driver task completed!\n');

    printDriverReturn(driverReturn);

    console.log('\n✨ Driver Adapter Flow completed successfully!');
  } catch (error) {
    console.error('\n❌ Driver Adapter Flow failed:');
    console.error(error);
    process.exit(1);
  }
}

// ── 输出六字段报告 ──
function printDriverReturn(report: DriverReturn): void {
  const divider = '═'.repeat(64);

  console.log(divider);
  console.log('📋 DriverReturn — 六字段报告');
  console.log(divider);

  // 字段1: Summary
  console.log('\n📝 1. Summary (执行摘要):');
  console.log(`   ${report.summary}`);

  // 字段2: Artifacts
  console.log('\n📦 2. Artifacts (产出制品):');
  if (report.artifacts.length === 0) {
    console.log('   (none)');
  } else {
    report.artifacts.forEach((a, i) => {
      console.log(`   [${i + 1}] type=${a.type}`);
      console.log(`       path=${a.path}`);
      console.log(`       summary=${a.summary}`);
    });
  }

  // 字段3: Decisions
  console.log('\n🧭 3. Decisions (关键决策):');
  if (report.decisions.length === 0) {
    console.log('   (none)');
  } else {
    report.decisions.forEach((d, i) => {
      console.log(`   [${i + 1}] ${d.point}`);
      console.log(`       选项: ${d.options.join(' | ')}`);
      console.log(`       选择: ${d.chosen}`);
      console.log(`       理由: ${d.reason}`);
    });
  }

  // 字段4: Blockers
  console.log('\n🚧 4. Blockers (阻塞项):');
  if (report.blockers.length === 0) {
    console.log('   (none)');
  } else {
    report.blockers.forEach((b, i) => {
      console.log(`   [${i + 1}] ${b.blocker}`);
      console.log(`       尝试: ${b.attempts.join('; ') || '(none)'}`);
      console.log(`       解决: ${b.resolution}`);
      console.log(`       已解决: ${b.resolved ? '✅' : '❌'}`);
    });
  }

  // 字段5: Referenced Experiences
  console.log('\n🔗 5. Referenced Experiences (引用经验):');
  if (report.referenced_experiences.length === 0) {
    console.log('   (none)');
  } else {
    report.referenced_experiences.forEach((e, i) => {
      console.log(`   [${i + 1}] exp_id=${e.experience_id}`);
      console.log(`       已应用: ${e.applied ? '✅' : '❌'}`);
      console.log(`       效果: ${e.effectiveness}`);
      console.log(`       备注: ${e.note}`);
    });
  }

  // 字段6: Assumptions
  console.log('\n⚠️  6. Assumptions (假设与风险):');
  if (report.assumptions.length === 0) {
    console.log('   (none)');
  } else {
    report.assumptions.forEach((a, i) => {
      console.log(`   [${i + 1}] 假设: ${a.assumption}`);
      console.log(`       错误风险: ${a.risk_if_wrong}`);
    });
  }

  console.log(`\n${divider}`);
}

// ── 环境文件加载（与 integration-v0.ts 共用逻辑） ──

function loadEnvFile(filePath: string): NodeJS.ProcessEnv {
  if (!existsSync(filePath)) {
    return {};
  }
  return parseEnvFile(readFileSync(filePath, 'utf8'));
}

function parseEnvFile(content: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separatorIndex = line.indexOf('=');
    if (separatorIndex <= 0) continue;
    const key = line.slice(0, separatorIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    env[key] = stripEnvValueQuotes(line.slice(separatorIndex + 1).trim());
  }
  return env;
}

function stripEnvValueQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

main();
