/**
 * Integration v0 Example
 *
 * End-to-end integration flow connecting A-B-C-D modules.
 *
 * Usage:
 *   # Default: MockDriver + single_agent + default prompt
 *   pnpm example:integration-v0
 *
 *   # With custom prompt
 *   pnpm example:integration-v0 "Fix the bug in login.ts"
 *
 *   # With council mode
 *   pnpm example:integration-v0 --enable-council
 *
 *   # With external driver (requires ACP_DRIVER_RUNNER_DIR)
 *   ACP_DRIVER_RUNNER_DIR=/path/to/acp-client-prototype pnpm example:integration-v0 --external-driver "Add user authentication"
 *
 *   # External driver + council + custom prompt
 *   ACP_DRIVER_RUNNER_DIR=/path/to/acp-client-prototype pnpm example:integration-v0 --external-driver --enable-council "Optimize database queries"
 *
 * Environment variables:
 *   - ACP_DRIVER_RUNNER_DIR: Path to acp-client-prototype (required for --external-driver)
 *   - ACP_DRIVER_ENV_FILE: Env file loaded for the external runner (default: <ACP_DRIVER_RUNNER_DIR>/.env)
 *   - ACP_AGENT_ID: Agent to use (default: mock-driver)
 *   - ACP_WORKSPACE: Workspace path (default: current directory)
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { runIntegrationV0Flow } from '../coordinator/integration-v0-flow';
import { ExternalDriverRuntime } from '../driver/external-driver-runtime';
import { CommandDriverTransport } from '../driver/command-driver-transport';
import type { DriverRuntimeHandle } from '../driver';

const CLAUDE_MODEL_OVERRIDE_ENV = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
] as const;

// Parse command line arguments
const args = process.argv.slice(2);
const enableCouncil = args.includes('--enable-council');
const useExternalDriver = args.includes('--external-driver');

// Extract custom prompt (first non-flag argument)
const customPrompt = args.find((arg) => !arg.startsWith('--'));
const driverPrompt = customPrompt || 'Produce a mock patch artifact for integration v0 test';

console.log('🚀 Integration v0 Flow\n');
console.log(`Mode: ${enableCouncil ? 'council' : 'single_agent'}`);
console.log(`Driver: ${useExternalDriver ? 'external (ACP)' : 'mock'}`);
console.log(`Prompt: "${driverPrompt}"\n`);

// Setup driver
let driver: DriverRuntimeHandle | undefined;

if (useExternalDriver) {
  const driverRunnerDir = process.env.ACP_DRIVER_RUNNER_DIR;

  if (!driverRunnerDir) {
    console.error(
      '❌ Error: ACP_DRIVER_RUNNER_DIR environment variable is required when using --external-driver.\n',
    );
    console.error('Example:');
    console.error(
      '  ACP_DRIVER_RUNNER_DIR=/path/to/acp-client-prototype pnpm example:integration-v0 --external-driver\n',
    );
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

  driver = new ExternalDriverRuntime({
    driver_id: 'acp-external',
    transport: new CommandDriverTransport({
      command: 'pnpm',
      args: ['--dir', driverRunnerDir, 'driver:run'],
      cwd: process.cwd(),
      env: {
        ...driverEnv,
        COREPACK_ENABLE_PROJECT_SPEC: process.env.COREPACK_ENABLE_PROJECT_SPEC || '0',
        PNPM_CONFIG_PM_ON_FAIL: process.env.PNPM_CONFIG_PM_ON_FAIL || 'ignore',
        ACP_AGENT_ID: process.env.ACP_AGENT_ID || 'mock-driver',
        ACP_WORKSPACE: process.env.ACP_WORKSPACE || process.cwd(),
      },
      unsetEnv,
    }),
  });
}

// Run integration flow
try {
  const flowOptions: {
    driver?: DriverRuntimeHandle;
    enableCouncil: boolean;
    driverPrompt: string;
  } = {
    enableCouncil,
    driverPrompt,
  };

  if (driver) {
    flowOptions.driver = driver;
  }

  const result = await runIntegrationV0Flow(flowOptions);

  // Print results
  console.log('✅ Integration v0 completed successfully!\n');
  console.log('📋 Summary:');
  console.log(`  Run ID: ${result.run_id}`);
  console.log(`  Task ID: ${result.task_id}`);
  console.log(`  Mode: ${result.summary.mode}`);
  console.log(`  Status: ${result.summary.status}`);
  console.log(`  Driver: ${result.summary.driver_diagnostics.driver_id}`);
  console.log(`  Duration: ${result.summary.driver_diagnostics.duration_ms}ms`);
  console.log(`  Artifacts: ${result.summary.artifacts_materialized}`);
  console.log(`  Files written: ${result.summary.files_written.length}`);

  console.log('\n📂 Worktree:');
  console.log(`  ${result.materialization_result.worktree_path}`);

  console.log('\n📊 Timeline:');
  for (const item of result.timeline) {
    console.log(`  ✓ ${item.name}`);
  }

  console.log('\n💾 Results saved to:');
  console.log(`  ${result.result_manifest.result_path}`);
  console.log(`  ${result.result_manifest.summary_path}`);
  console.log(`  ${result.result_manifest.timeline_path}`);
  console.log(`  ${result.result_manifest.message_thread_path}`);

  console.log('\n✨ Done!');
} catch (error) {
  console.error('\n❌ Integration v0 failed:');
  console.error(error);
  process.exit(1);
}

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
    if (!line || line.startsWith('#')) {
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }

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
