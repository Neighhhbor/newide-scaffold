import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createProductionBackendService } from '../../src/app/backend-rpc-stdio';
import type { IntegrationV0CoordinatorRunner } from '../../src/coordinator/coordinator-runner';
import { ExternalDriverRuntime } from '../../src/driver';
import { DriverRuntimeAgentExecutionFacade } from '../../src/memory';

describe('backend RPC stdio entrypoint', () => {
  it('fails fast when the configured ACP runner directory does not exist', () => {
    const runnerDir = path.join(process.cwd(), '.newide', 'missing-acp-runner');

    expect(() =>
      createProductionBackendService({
        ACP_DRIVER_RUNNER_DIR: runnerDir,
        ACP_AGENT_ID: 'claude',
      }),
    ).toThrow(`ACP driver runner directory not found: ${runnerDir}`);
  });

  it('assembles the production runner through B and the external A runtime', () => {
    const service = createProductionBackendService({
      ACP_DRIVER_RUNNER_DIR: process.cwd(),
      ACP_AGENT_ID: 'claude',
    });
    const runner = Reflect.get(service, 'runner') as IntegrationV0CoordinatorRunner;
    const defaults = Reflect.get(runner, 'defaults') as Record<string, unknown>;

    expect(defaults.driver).toBeInstanceOf(ExternalDriverRuntime);
    expect(defaults.agentExecutionFacade).toBeInstanceOf(DriverRuntimeAgentExecutionFacade);
    const transport = Reflect.get(defaults.driver as object, 'transport') as object;
    expect(Reflect.get(transport, 'env')).toMatchObject({ ACP_AGENT_ID: 'claude' });
  });

  it('answers ping over a real child process and exits on stdin EOF', async () => {
    const child = spawn('pnpm', ['backend:rpc'], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = createInterface({ input: child.stdout });
    const firstLine = once(lines, 'line');

    child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"system.ping"}\n');
    expect(JSON.parse(String((await firstLine)[0]))).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { status: 'ok', protocol_version: '0.1.0' },
    });

    child.stdin.end();
    const [code] = await once(child, 'exit');
    expect(code).toBe(0);
  }, 15_000);
});
