import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createProductionBackendService } from '../../src/app/backend-rpc-stdio';

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

  it('rejects a file and a package without the driver:run script as ACP runners', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'newide-acp-runner-'));
    const runnerFile = path.join(root, 'runner');
    writeFileSync(runnerFile, 'not a directory');
    expect(() => createProductionBackendService({ ACP_DRIVER_RUNNER_DIR: runnerFile })).toThrow(
      `ACP driver runner path is not a directory: ${runnerFile}`,
    );

    writeFileSync(path.join(root, 'package.json'), '{"scripts":{}}');
    expect(() => createProductionBackendService({ ACP_DRIVER_RUNNER_DIR: root })).toThrow(
      `ACP driver runner has no driver:run script: ${root}`,
    );
    rmSync(root, { recursive: true });
  });

  it('answers ping over a real child process and exits on stdin EOF', async () => {
    const runnerDir = mkdtempSync(path.join(os.tmpdir(), 'newide-acp-runner-'));
    writeFileSync(path.join(runnerDir, 'package.json'), '{"scripts":{"driver:run":"exit 0"}}');
    const child = spawn('pnpm', ['backend:rpc'], {
      cwd: process.cwd(),
      env: { ...process.env, ACP_DRIVER_RUNNER_DIR: runnerDir },
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
    rmSync(runnerDir, { recursive: true });
  }, 15_000);
});
