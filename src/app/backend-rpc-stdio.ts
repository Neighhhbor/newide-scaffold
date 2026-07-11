/**
 * NewIDE 后端 JSON-RPC stdio 入口。
 *
 * 这个文件只管理进程流和连接生命周期，业务方法由 NewideBackendService 提供。
 */
import { createInterface } from 'node:readline';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { IntegrationV0CoordinatorRunner } from '../coordinator/coordinator-runner';
import { CommandDriverTransport, ExternalDriverRuntime } from '../driver';
import { DriverRuntimeAgentExecutionFacade } from '../memory';
import { JsonRpcDispatcher, JsonRpcLineSession } from '../rpc/json-rpc-dispatcher';
import { RunRpcMethods } from '../rpc/run-methods';
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

export function createProductionBackendService(
  env: NodeJS.ProcessEnv = process.env,
): NewideBackendService {
  const repoRoot = process.cwd();
  const runnerDir = path.resolve(
    env.ACP_DRIVER_RUNNER_DIR ?? path.join(repoRoot, '..', 'acp-client-prototype'),
  );
  if (!existsSync(runnerDir)) {
    throw new Error(`ACP driver runner directory not found: ${runnerDir}`);
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
    }),
  });
  const runner = new IntegrationV0CoordinatorRunner({
    driver,
    agentExecutionFacade: new DriverRuntimeAgentExecutionFacade({ driver }),
  });
  return new NewideBackendService(runner);
}

export function startBackendRpcServer(options: BackendRpcServerOptions): BackendRpcServer {
  const dispatcher = new JsonRpcDispatcher();
  const session = new JsonRpcLineSession(dispatcher, options.writeLine);
  const methods = new RunRpcMethods(
    options.service ?? createProductionBackendService(),
    (method, params) => session.sendNotification(method, params),
  );
  methods.register(dispatcher);

  const lines = createInterface({ input: options.input, crlfDelay: Infinity });
  let pending = Promise.resolve();
  lines.on('line', (line) => {
    pending = pending
      .then(() => session.handleLine(line))
      .catch((error: unknown) => options.logError?.(String(error)));
  });
  lines.on('close', () => methods.dispose());

  return {
    close: () => {
      methods.dispose();
      lines.close();
    },
  };
}

function loadEnvFile(filePath: string): NodeJS.ProcessEnv {
  if (!existsSync(filePath)) return {};

  return Object.fromEntries(
    readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && line.includes('='))
      .map((line) => {
        const separator = line.indexOf('=');
        const value = line.slice(separator + 1).trim();
        return [line.slice(0, separator).trim(), value.replace(/^(["'])(.*)\1$/, '$2')];
      }),
  );
}

function runMain(): void {
  const server = startBackendRpcServer({
    input: process.stdin,
    writeLine: (line) => process.stdout.write(`${line}\n`),
    logError: (message) => process.stderr.write(`${message}\n`),
    ...(process.env.NEWIDE_BACKEND_RPC_TEST_MOCK === '1'
      ? { service: new NewideBackendService() }
      : {}),
  });
  process.once('SIGTERM', () => server.close());
  process.once('SIGINT', () => server.close());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMain();
}
