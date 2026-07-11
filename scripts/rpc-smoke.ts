import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
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

const testServer = `
import { startBackendRpcServer } from './src/app/backend-rpc-stdio.ts';
import { NewideBackendService } from './src/app/newide-backend-service.ts';
startBackendRpcServer({
  input: process.stdin,
  writeLine: (line) => process.stdout.write(line + '\\n'),
  service: new NewideBackendService(),
});
`;
const child = spawn('node', ['--import', 'tsx', '--input-type=module', '--eval', testServer], {
  cwd: process.cwd(),
  stdio: ['pipe', 'pipe', 'pipe'],
});
const stderr: string[] = [];
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
let backendExitError: Error | undefined;

try {
  const single = await runAndVerify('single_agent');
  const council = await runAndVerify('council');
  const cancelled = await createAndCancel();
  const parseError = await sendRaw('not-json\n', (message) => message.id === null);
  assert(parseError.error?.code === -32700, 'Malformed JSON did not return parse error');
  const unknown = await requestRaw('unknown.method', {});
  assert(unknown.error?.code === -32601, 'Unknown method did not return -32601');

  process.stdout.write(
    `${JSON.stringify({
      status: 'ok',
      single_agent: single,
      council,
      cancelled,
      malformed_json_error: parseError.error?.code,
      unknown_method_error: unknown.error?.code,
    })}\n`,
  );
} finally {
  child.stdin.end();
  const [exitCode] = await once(child, 'exit');
  if (exitCode !== 0) {
    backendExitError = new Error(`backend:rpc exited ${String(exitCode)}: ${stderr.join('')}`);
  }
  if (process.env.RPC_SMOKE_KEEP !== '1') {
    await Promise.all(
      runIds.flatMap((runId) => [fs.rm(`.newide/runs/${runId}`, { recursive: true, force: true })]),
    );
  }
}
if (backendExitError) throw backendExitError;

async function runAndVerify(mode: 'single_agent' | 'council'): Promise<Record<string, unknown>> {
  const created = await request<{ run_id: string; task_id: string; status: 'running' }>(
    'run.create',
    { prompt: `RPC smoke ${mode}`, mode },
  );
  runIds.push(created.run_id);
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
  }
  await assertRunFiles(created.run_id);
  const notificationTypes = messages
    .filter((message) => message.method === 'run.event')
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
  await request('run.cancel', { run_id: created.run_id });
  const snapshot = await request<RunSnapshot>('run.getSnapshot', { run_id: created.run_id });
  assert(snapshot.status === 'cancelled', `Cancelled run ended as ${snapshot.status}`);
  await assertRunFiles(created.run_id);
  return { run_id: created.run_id, status: snapshot.status };
}

async function waitForTerminal(runId: string): Promise<RunSnapshot> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const snapshot = await request<RunSnapshot>('run.getSnapshot', { run_id: runId });
    if (snapshot.status !== 'running') return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 5));
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
