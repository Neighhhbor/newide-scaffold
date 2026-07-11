import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';

describe('RPC smoke script', () => {
  it('verifies single-agent, Council, cancellation, and protocol errors', async () => {
    const child = spawn('pnpm', ['rpc:smoke'], {
      cwd: process.cwd(),
      env: { ...process.env, NEWIDE_BACKEND_RPC_TEST_MOCK: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));

    const [code] = await once(child, 'exit');
    expect(code, stderr).toBe(0);
    const summaryLine = stdout.split('\n').find((line) => line.startsWith('{"status"'));
    expect(summaryLine).toBeDefined();
    expect(JSON.parse(summaryLine!)).toMatchObject({
      status: 'ok',
      single_agent: { artifacts: 1 },
      council: { artifacts: 1 },
      cancelled: { status: 'cancelled' },
      malformed_json_error: -32700,
      unknown_method_error: -32601,
    });
  }, 30_000);
});
