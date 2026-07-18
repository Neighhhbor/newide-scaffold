import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AppRunEvent } from '../../src/app/run-registry';
import type { TaskSnapshot } from '../../src/protocol/task-snapshot';

describe('Task-first JSON-RPC child process acceptance', () => {
  it('runs create and autonomous Council under one durable Task', async () => {
    const runnerDir = mkdtempSync(path.join(os.tmpdir(), 'newide-task-rpc-runner-'));
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'newide-task-rpc-workspace-'));
    const createdRunIds = new Set<string>();
    const marketDirectories = new Set<string>();
    writeFakeDriver(runnerDir);
    const client = new RpcChildClient(spawnBackend(runnerDir));
    let restartedClient: RpcChildClient | undefined;

    try {
      await expect(client.call('system.ping')).resolves.toMatchObject({ status: 'ok' });
      const created = await client.call<TaskSnapshot>('task.create', {
        spec: 'Produce a result and then validate it with Council',
        completion_criteria: ['The autonomous Council produces a final artifact'],
        workspace_path: workspace,
      });
      expect(created.task.status).toBe('running');
      expect(created.current_run?.task_id).toBe(created.task.task_id);
      collectEvidence(created, createdRunIds, marketDirectories);

      const firstTerminal = await waitForTerminalTask(client, created.task.task_id);
      expect(firstTerminal.task.status).toBe('completed');
      expect(firstTerminal.run_history).toHaveLength(1);
      collectEvidence(firstTerminal, createdRunIds, marketDirectories);
      await client.call('task.subscribe', { task_id: created.task.task_id });

      const councilStarted = await client.call<TaskSnapshot>('task.startCouncil', {
        task_id: created.task.task_id,
      });
      expect(councilStarted.task.task_id).toBe(created.task.task_id);
      expect(councilStarted.current_run).toMatchObject({ mode: 'council', status: 'running' });
      expect(councilStarted.run_history).toHaveLength(1);
      collectEvidence(councilStarted, createdRunIds, marketDirectories);

      const councilTerminal = await waitForTerminalTask(client, created.task.task_id);
      collectEvidence(councilTerminal, createdRunIds, marketDirectories);
      expect(councilTerminal.task.status).toBe('completed');
      expect(councilTerminal.run_history).toHaveLength(2);
      expect(councilTerminal.council).toMatchObject({
        status: 'completed',
        result: {
          quality: expect.stringMatching(/^(verified|best_effort)$/),
          final_artifact_ref: expect.any(String),
          final_artifact_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      });
      expect(readFileSync(path.join(workspace, 'council-output.txt'), 'utf-8')).toContain(
        'COUNCIL_FINAL',
      );

      const liveCouncilEvents = client.taskEvents(created.task.task_id);
      const replayCursor = liveCouncilEvents.find((event) => event.type === 'run.created');
      expect(replayCursor).toBeDefined();
      expect(liveCouncilEvents.at(-1)).toMatchObject({ type: 'run.completed' });

      await client.close();
      restartedClient = new RpcChildClient(spawnBackend(runnerDir));
      await expect(restartedClient.call('system.ping')).resolves.toMatchObject({ status: 'ok' });
      await expect(
        restartedClient.call<TaskSnapshot>('task.get', { task_id: created.task.task_id }),
      ).resolves.toEqual(councilTerminal);
      const replayed = await restartedClient.call<{ replay_events: AppRunEvent[] }>(
        'task.subscribe',
        {
          task_id: created.task.task_id,
          after_event_id: replayCursor?.event_id,
        },
      );
      expect(replayed.replay_events).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'run.completed' })]),
      );

      const listed = await restartedClient.call<{ tasks: TaskSnapshot[] }>('task.list', {});
      expect(
        listed.tasks.filter((task) => task.task.task_id === created.task.task_id),
      ).toHaveLength(1);
    } finally {
      await client.close();
      await restartedClient?.close();
      rmSync(runnerDir, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
      for (const runId of createdRunIds) {
        rmSync(path.join('.newide', 'runs', runId), { recursive: true, force: true });
        rmSync(path.join('.newide', 'council', runId), { recursive: true, force: true });
      }
      for (const directory of marketDirectories) {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  }, 20_000);
});

class RpcChildClient {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private stderr = '';
  private readonly notifications: Array<{ method: string; params: unknown }> = [];

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    createInterface({ input: child.stdout }).on('line', (line) => {
      const message = JSON.parse(line) as {
        id?: number;
        method?: string;
        params?: unknown;
        result?: unknown;
        error?: { code: number; message: string };
      };
      if (message.id === undefined) {
        if (message.method)
          this.notifications.push({ method: message.method, params: message.params });
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(`JSON-RPC ${String(message.error.code)}: ${message.error.message}`),
        );
      } else {
        pending.resolve(message.result);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderr += chunk.toString('utf-8');
    });
    child.once('exit', () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error(`Backend exited before response. stderr: ${this.stderr}`));
      }
      this.pending.clear();
    });
  }

  call<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`,
      );
    });
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.stdin.end();
    await once(this.child, 'exit');
  }

  taskEvents(taskId: string): AppRunEvent[] {
    return this.notifications.flatMap((notification) => {
      if (notification.method !== 'task.event') return [];
      const params = notification.params as { task_id?: unknown; event?: unknown } | undefined;
      return params?.task_id === taskId && params.event ? [params.event as AppRunEvent] : [];
    });
  }
}

function spawnBackend(runnerDir: string): ChildProcessWithoutNullStreams {
  return spawn(
    process.execPath,
    ['--import', 'tsx', path.join(process.cwd(), 'test/fixtures/task-rpc-server.ts')],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ACP_DRIVER_RUNNER_DIR: runnerDir,
        NEWIDE_COORDINATION_DB: path.join(runnerDir, 'coordination.sqlite'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
}

async function waitForTerminalTask(client: RpcChildClient, taskId: string): Promise<TaskSnapshot> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const snapshot = await client.call<TaskSnapshot>('task.get', { task_id: taskId });
    if (!snapshot.current_run) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Task ${taskId} did not reach terminal state`);
}

function collectEvidence(
  snapshot: TaskSnapshot,
  runIds: Set<string>,
  marketDirectories: Set<string>,
): void {
  if (snapshot.current_run) runIds.add(snapshot.current_run.run_id);
  for (const run of snapshot.run_history) runIds.add(run.run_id);
  if (snapshot.market?.ledger_ref.startsWith('file:')) {
    marketDirectories.add(path.dirname(fileURLToPath(snapshot.market.ledger_ref)));
  }
}

function writeFakeDriver(runnerDir: string): void {
  writeFileSync(path.join(runnerDir, 'package.json'), '{"scripts":{"driver:run":"node fake.mjs"}}');
  writeFileSync(
    path.join(runnerDir, 'fake.mjs'),
    `import { createHash } from 'node:crypto';
let body='';
process.stdin.on('data', chunk => body += chunk);
process.stdin.on('end', () => {
  const input = JSON.parse(body);
  const created_at = new Date().toISOString();
  const councilRole = String(input.workspace_path || '').includes('.newide/council');
  const suffix = createHash('sha256').update(JSON.stringify([input.task_id, input.workspace_path, input.prompt, input.instruction, input.agent_id])).digest('hex').slice(0, 16);
  const artifact = { artifact_id: 'artifact_' + suffix, type: councilRole ? 'diff' : 'driver_result', uri: 'artifact://fake/result', producer_id: 'fake-acp', task_id: input.task_id, ...(councilRole ? { content: { kind: 'text', content_ref: 'data:text/plain,COUNCIL_FINAL%0A', target_path: 'council-output.txt', media_type: 'text/plain' } } : {}), created_at, schema_version: input.schema_version };
  process.stdout.write(JSON.stringify({ driver_run_result_id: 'driver_' + suffix, session_id: 'session_fake', status: 'succeeded', response: 'Fake ACP completed.', artifacts: [artifact], transcript_ref: { ...artifact, artifact_id: 'transcript_' + suffix, type: 'transcript' }, tool_events: [], diagnostics: { driver_id: 'fake-acp', duration_ms: 1, notes: [] }, created_at, schema_version: input.schema_version }));
});
`,
  );
  expect(existsSync(path.join(runnerDir, 'fake.mjs'))).toBe(true);
}
