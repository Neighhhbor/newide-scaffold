/**
 * NewIDE 后端 JSON-RPC stdio 入口。
 *
 * 这个文件只管理进程流和连接生命周期，业务方法由 NewideBackendService 提供。
 */
import { createInterface } from 'node:readline';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { IntegrationV0CoordinatorRunner } from '../coordinator/coordinator-runner';
import { SelectAgentHandler } from '../coordinator/handlers/select-agent-handler';
import { SynthesisAgentCouncilProvider } from '../council';
import { CommandDriverTransport, ExternalDriverRuntime } from '../driver';
import {
  FileBufferRepository,
  InMemoryRepository,
  LiteLLMToolCallingClient,
  RepositoryAgentBoardQuery,
  type ToolCallingClient,
} from '../memory';
import { BAgentProjectionAdapter, FileMarketEvidenceStore } from '../market';
import { JsonRpcDispatcher, JsonRpcLineSession } from '../rpc/json-rpc-dispatcher';
import { RunRpcMethods } from '../rpc/run-methods';
import { TaskRpcMethods } from '../rpc/task-methods';
import { DriverRuntimeAgentExecutionFacade } from './driver-runtime-agent-execution-facade';
import { FileAgentExecutionEvidenceStore } from './agent-execution-evidence-store';
import { NewideBackendService } from './newide-backend-service';

export interface BackendRpcServerOptions {
  input: Readable;
  writeLine: (line: string) => void;
  service?: NewideBackendService;
  logError?: (message: string) => void;
}

export interface BackendRpcServer {
  close(): void;
}

export interface ProductionBackendServiceDependencies {
  agentLlm?: ToolCallingClient;
}

export function createProductionBackendService(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: ProductionBackendServiceDependencies = {},
): NewideBackendService {
  const repoRoot = process.cwd();
  const runnerDir = path.resolve(
    env.ACP_DRIVER_RUNNER_DIR ?? path.join(repoRoot, '..', 'acp-client-prototype'),
  );
  if (!existsSync(runnerDir)) {
    throw new Error(`ACP driver runner directory not found: ${runnerDir}`);
  }
  if (!statSync(runnerDir).isDirectory()) {
    throw new Error(`ACP driver runner path is not a directory: ${runnerDir}`);
  }
  const packagePath = path.join(runnerDir, 'package.json');
  const runnerPackage = readJson(packagePath);
  if (!hasDriverRunScript(runnerPackage)) {
    throw new Error(`ACP driver runner has no driver:run script: ${runnerDir}`);
  }

  const driverEnv = loadEnvFile(env.ACP_DRIVER_ENV_FILE ?? path.join(runnerDir, '.env'));
  const driver = new ExternalDriverRuntime({
    driver_id: 'acp-external',
    transport: new CommandDriverTransport({
      command: 'pnpm',
      args: ['--dir', runnerDir, 'driver:run'],
      cwd: repoRoot,
      env: {
        ...driverEnv,
        COREPACK_ENABLE_PROJECT_SPEC: env.COREPACK_ENABLE_PROJECT_SPEC ?? '0',
        PNPM_CONFIG_PM_ON_FAIL: env.PNPM_CONFIG_PM_ON_FAIL ?? 'ignore',
        ACP_AGENT_ID: env.ACP_AGENT_ID ?? 'claude',
        ACP_WORKSPACE: env.ACP_WORKSPACE ?? path.join(repoRoot, '.newide', 'test-workspace'),
      },
      unsetEnv: MODEL_OVERRIDE_ENV.filter((key) => driverEnv[key] === undefined),
      timeoutMs: readDriverTimeout(env.ACP_DRIVER_TIMEOUT_MS),
    }),
  });
  const repository = new InMemoryRepository();
  const agentExecutionFacade = new DriverRuntimeAgentExecutionFacade({
    driver,
    repository,
    bufferRepository: new FileBufferRepository({
      agentStateRoot: path.join(repoRoot, '.newide', 'b', 'agent-state'),
    }),
    llm: dependencies.agentLlm ?? new LiteLLMToolCallingClient(),
    evidenceStore: new FileAgentExecutionEvidenceStore({
      root: path.join(repoRoot, '.newide', 'b', 'context-packs'),
    }),
  });
  const selectAgentHandler = new SelectAgentHandler({
    projectionSource: new BAgentProjectionAdapter({
      competitionQuery: agentExecutionFacade,
      boardQuery: new RepositoryAgentBoardQuery(repository),
      ensureAgent: (agentId) => agentExecutionFacade.ensureAgent(agentId),
    }),
    evidenceStore: new FileMarketEvidenceStore({
      root: path.join(repoRoot, '.newide', 'market'),
    }),
  });
  const runner = new IntegrationV0CoordinatorRunner({
    driver,
    agentExecutionFacade,
    selectAgentHandler,
    councilProvider: new SynthesisAgentCouncilProvider({ agentExecutionFacade }),
  });
  return new NewideBackendService(runner);
}

const MODEL_OVERRIDE_ENV = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
];

function readDriverTimeout(value: string | undefined): number {
  if (value === undefined) return 120_000;
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout <= 0) {
    throw new Error('ACP_DRIVER_TIMEOUT_MS must be a positive integer');
  }
  return timeout;
}

function readJson(filePath: string): unknown {
  if (!existsSync(filePath)) return undefined;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`ACP driver runner package.json is invalid: ${filePath}`, { cause: error });
  }
}

function hasDriverRunScript(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const scripts = Reflect.get(value, 'scripts');
  const command = scripts && typeof scripts === 'object' && Reflect.get(scripts, 'driver:run');
  return typeof command === 'string' && command.trim().length > 0;
}

export function startBackendRpcServer(options: BackendRpcServerOptions): BackendRpcServer {
  const dispatcher = new JsonRpcDispatcher();
  const session = new JsonRpcLineSession(dispatcher, options.writeLine);
  const service = options.service ?? createProductionBackendService();
  const runMethods = new RunRpcMethods(service, (method, params) =>
    session.sendNotification(method, params),
  );
  const taskMethods = new TaskRpcMethods(service);
  runMethods.register(dispatcher);
  taskMethods.register(dispatcher);

  const lines = createInterface({ input: options.input, crlfDelay: Infinity });
  let pending = Promise.resolve();
  lines.on('line', (line) => {
    pending = pending
      .then(() => session.handleLine(line))
      .catch((error: unknown) => options.logError?.(String(error)));
  });
  lines.on('close', () => runMethods.dispose());

  return {
    close: () => {
      runMethods.dispose();
      lines.close();
    },
  };
}

function loadEnvFile(filePath: string): NodeJS.ProcessEnv {
  if (!existsSync(filePath)) return {};

  return parseDriverEnv(readFileSync(filePath, 'utf8'));
}

export function parseDriverEnv(content: string): NodeJS.ProcessEnv {
  return Object.fromEntries(
    content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .flatMap((line) => {
        if (!line || line.startsWith('#')) return [];
        const separator = line.indexOf('=');
        if (separator <= 0) return [];
        const key = line.slice(0, separator).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return [];
        const value = line.slice(separator + 1).trim();
        return [[key, value.replace(/^(["'])(.*)\1$/, '$2')]];
      }),
  );
}

function runMain(): void {
  const server = startBackendRpcServer({
    input: process.stdin,
    writeLine: (line) => process.stdout.write(`${line}\n`),
    logError: (message) => process.stderr.write(`${message}\n`),
  });
  process.once('SIGTERM', () => server.close());
  process.once('SIGINT', () => server.close());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMain();
}
