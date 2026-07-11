import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { RunSnapshot } from '../src/protocol/run-snapshot';

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const runnerDir = await createFakeAcpRunner();
const invocationLog = path.join(runnerDir, 'invocations.log');
const child = spawn('pnpm', ['backend:rpc'], {
  cwd: process.cwd(),
  env: { ...process.env, ACP_DRIVER_RUNNER_DIR: runnerDir },
  stdio: ['pipe', 'pipe', 'pipe'],
});
const stderr: string[] = [];
let spawnError: Error | undefined;
const childClosed = new Promise<number | null>((resolve) => {
  child.once('error', (error) => {
    spawnError = error;
    resolve(null);
  });
  child.once('close', resolve);
});
child.stderr.on('data', (chunk) => stderr.push(String(chunk)));

const messages: JsonRpcMessage[] = [];
const waiters = new Set<{
  predicate: (message: JsonRpcMessage) => boolean;
  resolve: (message: JsonRpcMessage) => void;
}>();
createInterface({ input: child.stdout }).on('line', (line) => {
  const message = JSON.parse(line) as JsonRpcMessage;
  messages.push(message);
  for (const waiter of waiters) {
    if (!waiter.predicate(message)) continue;
    waiters.delete(waiter);
    waiter.resolve(message);
  }
});

let nextId = 1;
const runIds: string[] = [];
const taskIds: string[] = [];
let backendExitError: Error | undefined;

try {
  const single = await runAndVerify('single_agent');
  const council = await runAndVerify('council');
  const driverInvocations = await countDriverInvocations();
  assert(driverInvocations === 6, `Expected 6 driver invocations, received ${driverInvocations}`);
  const cancelled = await createAndCancel();
  const parseError = await sendRaw('not-json\n', (message) => message.id === null);
  assert(parseError.error?.code === -32700, 'Malformed JSON did not return parse error');
  const unknown = await requestRaw('unknown.method', {});
  assert(unknown.error?.code === -32601, 'Unknown method did not return -32601');

  process.stdout.write(
    `${JSON.stringify({
      status: 'ok',
      runtime: 'production-composition-fake-acp',
      single_agent: single,
      council,
      driver_invocations: driverInvocations,
      cancelled,
      malformed_json_error: parseError.error?.code,
      unknown_method_error: unknown.error?.code,
    })}\n`,
  );
} finally {
  child.stdin.end();
  const exitCode = await waitForBackendClose();
  if (spawnError) {
    backendExitError = new Error(`backend:rpc failed to start: ${spawnError.message}`);
  } else if (exitCode !== 0) {
    backendExitError = new Error(`backend:rpc exited ${String(exitCode)}: ${stderr.join('')}`);
  }
  if (process.env.RPC_SMOKE_KEEP !== '1') {
    await Promise.all([
      ...runIds.map((runId) => fs.rm(`.newide/runs/${runId}`, { recursive: true, force: true })),
      ...taskIds.map((taskId) =>
        fs.rm(`.newide/worktrees/${taskId}`, { recursive: true, force: true }),
      ),
      fs.rm(runnerDir, { recursive: true, force: true }),
    ]);
  }
}
if (backendExitError) throw backendExitError;

async function runAndVerify(mode: 'single_agent' | 'council'): Promise<Record<string, unknown>> {
  const created = await request<{ run_id: string; task_id: string; status: 'running' }>(
    'run.create',
    { prompt: `RPC smoke ${mode}`, mode },
  );
  runIds.push(created.run_id);
  taskIds.push(created.task_id);
  await request('run.subscribe', { run_id: created.run_id });
  const snapshot = await waitForTerminal(created.run_id);
  assert(snapshot.status === 'completed', `${mode} run ended as ${snapshot.status}`);
  assert(snapshot.timeline.length > 0, `${mode} snapshot has no timeline`);
  assert(snapshot.artifacts.length > 0, `${mode} snapshot has no artifacts`);
  assert(snapshot.gates.length > 0, `${mode} snapshot has no gates`);
  assert(snapshot.final_output?.status === 'completed', `${mode} final output is incomplete`);
  if (mode === 'council') {
    assert(snapshot.council?.verdict === 'select', 'Council snapshot has no selected decision');
    assert(
      snapshot.council.can_create_merge_authorization === false,
      'Council unexpectedly authorizes merge',
    );
    assert(snapshot.gates.length === 2, 'Council did not execute pre and post gates');
    const eventTypes = snapshot.timeline.map((event) => event.type);
    const councilCompleted = eventTypes.indexOf('council.completed');
    const artifactSelected = eventTypes.indexOf('artifact.selected');
    const postGate = eventTypes.lastIndexOf('gate.result');
    const materializedEvent = eventTypes.indexOf('worktree.materialized');
    assert(
      [councilCompleted, artifactSelected, postGate, materializedEvent].every(
        (index) => index >= 0,
      ),
      'Council post-gate events are incomplete',
    );
    assert(
      councilCompleted < artifactSelected &&
        artifactSelected < postGate &&
        postGate < materializedEvent,
      'Council post-gate event order is invalid',
    );
    assert(
      snapshot.final_output.files_written.length > 0,
      'Council candidate content was not materialized',
    );
    const materialized = snapshot.final_output.files_written[0];
    assert(
      (await fs.readFile(materialized, 'utf8')).startsWith('production composition smoke '),
      'Council materialized file does not contain driver output',
    );
  }
  await assertRunFiles(created.run_id);
  const notificationTypes = messages
    .filter(
      (message) =>
        message.method === 'run.event' &&
        (message.params as { run_id?: string }).run_id === created.run_id,
    )
    .map((message) => (message.params as { event?: { type?: string } }).event?.type)
    .filter((type): type is string => Boolean(type));
  assert(notificationTypes.includes('run.completed'), `${mode} emitted no completion notification`);
  return {
    run_id: created.run_id,
    events: snapshot.timeline.length,
    artifacts: snapshot.artifacts.length,
  };
}

async function createAndCancel(): Promise<Record<string, unknown>> {
  const created = await request<{ run_id: string; task_id: string; status: 'running' }>(
    'run.create',
    { prompt: 'RPC smoke cancellation', mode: 'single_agent' },
  );
  runIds.push(created.run_id);
  taskIds.push(created.task_id);
  await request('run.cancel', { run_id: created.run_id });
  const snapshot = await request<RunSnapshot>('run.getSnapshot', { run_id: created.run_id });
  assert(snapshot.status === 'cancelled', `Cancelled run ended as ${snapshot.status}`);
  await assertRunFiles(created.run_id);
  return { run_id: created.run_id, status: snapshot.status };
}

async function waitForTerminal(runId: string): Promise<RunSnapshot> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const snapshot = await request<RunSnapshot>('run.getSnapshot', { run_id: runId });
    if (snapshot.status !== 'running') return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Run ${runId} did not reach a terminal state`);
}

async function assertRunFiles(runId: string): Promise<void> {
  await Promise.all([
    fs.access(`.newide/runs/${runId}/audit.jsonl`),
    fs.access(`.newide/runs/${runId}/result.json`),
    fs.access(`.newide/runs/${runId}/frontend-snapshot.json`),
  ]);
}

async function request<T = unknown>(method: string, params: unknown): Promise<T> {
  const response = await requestRaw(method, params);
  if (response.error)
    throw new Error(`${method}: ${response.error.code} ${response.error.message}`);
  return response.result as T;
}

async function requestRaw(method: string, params: unknown): Promise<JsonRpcMessage> {
  const id = nextId++;
  const waiting = waitForMessage((message) => message.id === id);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return waiting;
}

async function sendRaw(
  line: string,
  predicate: (message: JsonRpcMessage) => boolean,
): Promise<JsonRpcMessage> {
  const waiting = waitForMessage(predicate);
  child.stdin.write(line);
  return waiting;
}

function waitForMessage(predicate: (message: JsonRpcMessage) => boolean): Promise<JsonRpcMessage> {
  const existing = messages.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const waiter = { predicate, resolve };
    waiters.add(waiter);
    setTimeout(() => {
      if (!waiters.delete(waiter)) return;
      reject(new Error(`Timed out waiting for backend message. stderr=${stderr.join('')}`));
    }, 15_000).unref();
  });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function countDriverInvocations(): Promise<number> {
  const contents = await fs.readFile(invocationLog, 'utf8');
  return contents.trim().split('\n').filter(Boolean).length;
}

async function waitForBackendClose(): Promise<number | null> {
  const timeout = new Promise<'timeout'>((resolve) =>
    setTimeout(() => resolve('timeout'), 5_000).unref(),
  );
  const result = await Promise.race([childClosed, timeout]);
  if (result !== 'timeout') return result;
  child.kill('SIGTERM');
  const terminated = await Promise.race([
    childClosed,
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 1_000).unref()),
  ]);
  if (terminated !== 'timeout') return terminated;
  child.kill('SIGKILL');
  return childClosed;
}

async function createFakeAcpRunner(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'newide-rpc-smoke-acp-'));
  try {
    await fs.writeFile(
      path.join(directory, 'package.json'),
      JSON.stringify({ private: true, scripts: { 'driver:run': 'node fake-driver.mjs' } }),
    );
    await fs.writeFile(
      path.join(directory, 'fake-driver.mjs'),
      `import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
let body = '';
process.stdin.on('data', chunk => body += chunk);
process.stdin.on('end', () => {
  const input = JSON.parse(body);
  const suffix = randomUUID();
  const created_at = new Date().toISOString();
  const artifact = {
    artifact_id: 'artifact_' + suffix,
    type: 'driver_result',
    uri: 'artifact://fake-acp/' + suffix,
    producer_id: 'claude-fake',
    task_id: input.task_id,
    created_at,
    schema_version: input.schema_version,
    content: {
      kind: 'text',
      content_ref: 'data:text/plain,' + encodeURIComponent('production composition smoke ' + suffix),
      target_path: 'output/' + suffix + '.txt'
    }
  };
  appendFileSync(new URL('./invocations.log', import.meta.url), 'invoke\\n');
  const writeResult = () => process.stdout.write(JSON.stringify({
    driver_run_result_id: 'driver_result_' + suffix,
    session_id: 'session_' + suffix,
    status: 'succeeded',
    artifacts: [artifact],
    transcript_ref: { ...artifact, artifact_id: 'transcript_' + suffix, type: 'transcript', content: undefined },
    tool_events: [],
    diagnostics: { driver_id: 'claude-fake', duration_ms: 1, notes: ['fake ACP process'] },
    created_at,
    schema_version: input.schema_version
  }));
  if (input.prompt.includes('RPC smoke cancellation')) setTimeout(writeResult, 250);
  else writeResult();
});
`,
    );
    return directory;
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}
