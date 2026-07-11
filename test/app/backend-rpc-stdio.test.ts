import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createProductionBackendService, parseDriverEnv } from '../../src/app/backend-rpc-stdio';

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
    writeFileSync(path.join(root, 'package.json'), '{"scripts":{"driver:run":"   "}}');
    expect(() => createProductionBackendService({ ACP_DRIVER_RUNNER_DIR: root })).toThrow(
      `ACP driver runner has no driver:run script: ${root}`,
    );
    rmSync(root, { recursive: true });
  });

  it('parses only valid env assignments and preserves equals signs in values', () => {
    expect(
      parseDriverEnv('GOOD="quoted"\nTOKEN=a=b=c\nINVALID-KEY=no\n=no-key\n# comment'),
    ).toEqual({ GOOD: 'quoted', TOKEN: 'a=b=c' });
  });

  it('executes the production C-to-B-to-A chain through a real driver:run process', async () => {
    const runnerDir = mkdtempSync(path.join(os.tmpdir(), 'newide-fake-acp-'));
    writeFileSync(
      path.join(runnerDir, 'package.json'),
      '{"scripts":{"driver:run":"node fake-driver.mjs"}}',
    );
    writeFileSync(
      path.join(runnerDir, 'fake-driver.mjs'),
      `import { appendFileSync } from 'node:fs';
let body='';
process.stdin.on('data', chunk => body += chunk);
process.stdin.on('end', () => {
  appendFileSync(new URL('./invocations.log', import.meta.url), 'invoke\\n');
  const input = JSON.parse(body);
  const created_at = new Date().toISOString();
  const artifact = { artifact_id: 'artifact_fake_acp', type: 'driver_result', uri: 'artifact://fake/result', producer_id: 'claude-fake', task_id: input.task_id, created_at, schema_version: input.schema_version };
  process.stdout.write(JSON.stringify({ driver_run_result_id: 'driver_result_fake_acp', session_id: 'session_fake_acp', status: 'succeeded', artifacts: [artifact], transcript_ref: { ...artifact, artifact_id: 'transcript_fake_acp', type: 'transcript' }, tool_events: [], diagnostics: { driver_id: 'claude-fake', duration_ms: 1, notes: ['fake ACP process'] }, created_at, schema_version: input.schema_version }));
});
`,
    );

    const service = createProductionBackendService({ ACP_DRIVER_RUNNER_DIR: runnerDir });
    const created = await service.createRun({ prompt: 'Exercise production composition.' });
    const snapshot = await waitForTerminal(service, created.run_id);

    expect(snapshot.status).toBe('completed');
    expect(snapshot.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['agent.execution_requested', 'agent.execution_completed']),
    );
    expect(snapshot.snapshot?.delivery_report.driver_diagnostics.driver_id).toBe('claude-fake');
    expect(snapshot.snapshot?.delivery_report.driver_diagnostics.driver_id).not.toBe('mock-driver');
    expect(snapshot.events).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'agent.execution_completed' })]),
    );

    const councilCreated = await service.createRun({
      prompt: 'Exercise production council composition.',
      mode: 'council',
    });
    const councilSnapshot = await waitForTerminal(service, councilCreated.run_id);
    expect(councilSnapshot.status).toBe('completed');
    expect(councilSnapshot.events.map((event) => event.type)).toContain('council.completed');
    expect(
      readFileSync(path.join(runnerDir, 'invocations.log'), 'utf8').trim().split('\n'),
    ).toHaveLength(6);

    await new Promise((resolve) => setTimeout(resolve, 50));
    rmSync(runnerDir, { recursive: true });
    rmSync(path.join('.newide', 'runs', created.run_id), { recursive: true, force: true });
    rmSync(path.join('.newide', 'worktrees', created.task_id), { recursive: true, force: true });
    rmSync(path.join('.newide', 'runs', councilCreated.run_id), { recursive: true, force: true });
    rmSync(path.join('.newide', 'worktrees', councilCreated.task_id), {
      recursive: true,
      force: true,
    });
  }, 15_000);

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

async function waitForTerminal(
  service: ReturnType<typeof createProductionBackendService>,
  runId: string,
) {
  await service.waitForTerminal(runId);
  return service.getSnapshot(runId);
}
