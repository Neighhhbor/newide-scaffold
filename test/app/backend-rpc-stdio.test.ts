import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createProductionBackendService, parseDriverEnv } from '../../src/app/backend-rpc-stdio';
import type { AppRunEvent } from '../../src/app/run-registry';
import type { ToolCallingClient } from '../../src/memory';

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
    let created: { run_id: string; task_id: string } | undefined;
    let councilCreated: { run_id: string; task_id: string } | undefined;
    let failedCouncilCreated: { run_id: string; task_id: string } | undefined;
    try {
      writeFileSync(
        path.join(runnerDir, 'package.json'),
        '{"scripts":{"driver:run":"node fake-driver.mjs"}}',
      );
      writeFileSync(
        path.join(runnerDir, 'fake-driver.mjs'),
        `import { appendFileSync, existsSync } from 'node:fs';
let body='';
process.stdin.on('data', chunk => body += chunk);
process.stdin.on('end', () => {
  const invocationLog = new URL('./invocations.log', import.meta.url);
  appendFileSync(invocationLog, 'invoke\\n');
  const input = JSON.parse(body);
  appendFileSync(new URL('./prompts.log', import.meta.url), input.prompt + '\\n');
  const created_at = new Date().toISOString();
  const reviewerFailed = existsSync(new URL('./fail-reviewer', import.meta.url)) && input.prompt.includes('Review proposals:');
  const artifact = { artifact_id: 'artifact_fake_acp', type: 'driver_result', uri: 'artifact://fake/result', producer_id: 'claude-fake', task_id: input.task_id, created_at, schema_version: input.schema_version };
  process.stdout.write(JSON.stringify({ driver_run_result_id: 'driver_result_fake_acp', session_id: 'session_fake_acp', status: reviewerFailed ? 'failed' : 'succeeded', artifacts: reviewerFailed ? [] : [artifact], transcript_ref: { ...artifact, artifact_id: 'transcript_fake_acp', type: 'transcript' }, tool_events: [], diagnostics: { driver_id: 'claude-fake', duration_ms: 1, notes: ['fake ACP process'] }, ...(reviewerFailed ? { error: { code: 'FAKE_REVIEW_FAILURE', message: 'controlled failure', retryable: false } } : {}), created_at, schema_version: input.schema_version }));
});
`,
      );

      const service = createProductionBackendService(
        { ACP_DRIVER_RUNNER_DIR: runnerDir },
        { agentLlm: invokeDriverLlm() },
      );
      created = await service.createRun({ prompt: 'Exercise production composition.' });
      const snapshot = await waitForTerminal(service, created.run_id);

      expect(snapshot.status).toBe('completed');
      expect(snapshot.events.map((event) => event.type)).toEqual(
        expect.arrayContaining(['agent.execution_requested', 'agent.execution_completed']),
      );
      expect(snapshot.snapshot?.delivery_report.driver_diagnostics.driver_id).toBe('claude-fake');
      expect(snapshot.snapshot?.delivery_report.driver_diagnostics.driver_id).not.toBe(
        'mock-driver',
      );
      expect(snapshot.events).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'agent.execution_completed' })]),
      );

      councilCreated = await service.createRun({
        prompt: 'Exercise production council composition.',
        mode: 'council',
      });
      const notifications: AppRunEvent[] = [];
      const unsubscribe = service.subscribe(councilCreated.run_id, (event) =>
        notifications.push(event),
      );
      const councilSnapshot = await waitForTerminal(service, councilCreated.run_id);
      unsubscribe();
      expect(councilSnapshot.status).toBe('completed');
      const councilEventTypes = councilSnapshot.events.map((event) => event.type);
      expect(
        councilEventTypes.filter((type) => type === 'council.proposal.completed'),
      ).toHaveLength(2);
      expect(councilEventTypes.filter((type) => type === 'council.review.completed')).toHaveLength(
        1,
      );
      expect(
        councilEventTypes.filter((type) => type === 'council.synthesis.completed'),
      ).toHaveLength(1);
      expect(councilEventTypes.filter((type) => type === 'gate.result')).toHaveLength(2);
      expect(councilEventTypes.indexOf('council.completed')).toBeLessThan(
        councilEventTypes.indexOf('artifact.selected'),
      );
      expect(councilEventTypes.indexOf('artifact.selected')).toBeLessThan(
        councilEventTypes.lastIndexOf('gate.result'),
      );
      expect(councilEventTypes.lastIndexOf('gate.result')).toBeLessThan(
        councilEventTypes.indexOf('worktree.materialized'),
      );
      expect(councilSnapshot.snapshot?.delivery_report.files_written.length).toBeGreaterThan(0);
      const audit = readFileSync(
        path.join('.newide', 'runs', councilCreated.run_id, 'audit.jsonl'),
        'utf8',
      )
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as AppRunEvent);
      const keyTypes = [
        'council.completed',
        'artifact.selected',
        'gate.result',
        'worktree.materialized',
      ];
      const expectedOrder = [
        'council.completed',
        'artifact.selected',
        'gate.result',
        'worktree.materialized',
      ];
      const postCouncilSequence = (types: string[]) =>
        types.slice(types.indexOf('council.completed')).filter((type) => keyTypes.includes(type));
      expect(postCouncilSequence(notifications.map((event) => event.type))).toEqual(expectedOrder);
      expect(postCouncilSequence(audit.map((event) => event.type))).toEqual(expectedOrder);
      expect(postCouncilSequence(councilEventTypes)).toEqual(expectedOrder);
      expect(
        readFileSync(path.join(runnerDir, 'invocations.log'), 'utf8').trim().split('\n'),
      ).toHaveLength(6);
      const driverPrompts = readFileSync(path.join(runnerDir, 'prompts.log'), 'utf8');
      expect(driverPrompts).toContain('Exercise production composition.');
      expect(driverPrompts).toContain('Produce proposal A for:');
      expect(driverPrompts).toContain('Review proposals:');
      expect(driverPrompts).toContain('Synthesize the final candidate');

      writeFileSync(path.join(runnerDir, 'fail-reviewer'), '1');
      failedCouncilCreated = await service.createRun({
        prompt: 'Exercise structured Council reviewer failure.',
        mode: 'council',
      });
      const failedNotifications: AppRunEvent[] = [];
      const unsubscribeFailed = service.subscribe(failedCouncilCreated.run_id, (event) =>
        failedNotifications.push(event),
      );
      const failedSnapshot = await waitForTerminal(service, failedCouncilCreated.run_id);
      unsubscribeFailed();
      expect(service.getRunSnapshot(failedCouncilCreated.run_id)).toMatchObject({
        status: 'failed',
        errors: [
          {
            code: 'COUNCIL_REVIEW_FAILED',
            message: 'Council review role failed',
            details: {
              phase: 'council',
              council_phase: 'review',
              role_id: 'reviewer',
              agent_status: 'failed',
            },
          },
        ],
      });
      expect(failedNotifications.map((event) => event.type)).toEqual(
        expect.arrayContaining(['council.failed', 'run.failed']),
      );
      expect(failedSnapshot.events.map((event) => event.type)).not.toContain('council.completed');
      expect(failedSnapshot.events.map((event) => event.type)).not.toContain(
        'worktree.materialized',
      );
      const failedAudit = readFileSync(
        path.join('.newide', 'runs', failedCouncilCreated.run_id, 'audit.jsonl'),
        'utf8',
      )
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as AppRunEvent);
      expect(failedAudit.map((event) => event.type)).toEqual(
        expect.arrayContaining(['council.failed', 'run.failed']),
      );
    } finally {
      rmSync(runnerDir, { recursive: true, force: true });
      if (created) {
        rmSync(path.join('.newide', 'runs', created.run_id), { recursive: true, force: true });
        rmSync(path.join('.newide', 'worktrees', created.task_id), {
          recursive: true,
          force: true,
        });
      }
      if (councilCreated) {
        rmSync(path.join('.newide', 'runs', councilCreated.run_id), {
          recursive: true,
          force: true,
        });
        rmSync(path.join('.newide', 'worktrees', councilCreated.task_id), {
          recursive: true,
          force: true,
        });
      }
      if (failedCouncilCreated) {
        rmSync(path.join('.newide', 'runs', failedCouncilCreated.run_id), {
          recursive: true,
          force: true,
        });
        rmSync(path.join('.newide', 'worktrees', failedCouncilCreated.task_id), {
          recursive: true,
          force: true,
        });
      }
    }
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

function invokeDriverLlm(): ToolCallingClient {
  let sequence = 0;
  return {
    async completeWithTools(input) {
      const lastMessage = input.messages.at(-1);
      if (lastMessage?.role === 'tool') {
        return { content: 'Task completed. [done]', tool_calls: undefined };
      }
      const userMessage = [...input.messages].reverse().find((message) => message.role === 'user');
      sequence += 1;
      return {
        content: null,
        tool_calls: [
          {
            id: `backend_tool_call_${String(sequence)}`,
            type: 'function',
            function: {
              name: 'invoke_driver',
              arguments: JSON.stringify({
                instruction: userMessage?.content?.replace(/^Task:\s*/, '') ?? 'Execute task.',
              }),
            },
          },
        ],
      };
    },
  };
}
