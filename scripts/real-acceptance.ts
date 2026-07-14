/**
 * 真实链路验收脚本（不注入 fake B LLM，不使用 fake ACP runner）。
 *
 * 用真实 production composition（createProductionBackendService 经 `pnpm backend:rpc`
 * 子进程）执行三个场景：council / subagent / restart。
 * 结果打印到控制台，并留档到 .newide/acceptance/<timestamp>/。
 *
 * 用法：
 *   pnpm acceptance:real -- --workspace /absolute/path --scenario all
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type Scenario = 'council' | 'subagent' | 'restart';

interface CliOptions {
  workspace: string;
  scenarios: Scenario[];
}

interface ScenarioReport {
  scenario: Scenario;
  status: 'passed' | 'failed';
  details: Record<string, unknown>;
  errors: string[];
}

const repoRoot = process.cwd();
const options = parseCli(process.argv.slice(2));
const startedAt = new Date();
const acceptanceDir = path.resolve(
  repoRoot,
  '.newide',
  'acceptance',
  startedAt.toISOString().replace(/[:.]/g, '-'),
);
const runTimeoutMs = readPositiveInt(process.env.ACCEPTANCE_RUN_TIMEOUT_MS, 900_000);

await fs.mkdir(options.workspace, { recursive: true });
await fs.mkdir(acceptanceDir, { recursive: true });

log(`workspace: ${options.workspace}`);
log(`acceptance dir: ${acceptanceDir}`);
log(`scenarios: ${options.scenarios.join(', ')}`);

const reports: ScenarioReport[] = [];
for (const scenario of options.scenarios) {
  log('');
  log(`=== scenario: ${scenario} ===`);
  const report =
    scenario === 'council'
      ? await runCouncilScenario()
      : scenario === 'subagent'
        ? await runSubagentScenario()
        : await runRestartScenario();
  reports.push(report);
  await fs.writeFile(
    path.join(acceptanceDir, `${scenario}.json`),
    JSON.stringify(report, null, 2),
    'utf-8',
  );
  log(`--- ${scenario}: ${report.status} ---`);
}

const summary = {
  schema_version: 'v0',
  started_at: startedAt.toISOString(),
  finished_at: new Date().toISOString(),
  workspace: options.workspace,
  repo_root: repoRoot,
  acceptance_dir: acceptanceDir,
  scenarios: reports,
};
const summaryPath = path.join(acceptanceDir, 'summary.json');
await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf-8');

log('');
log('=== acceptance summary ===');
for (const report of reports) {
  log(`${report.scenario}: ${report.status}`);
  for (const error of report.errors) log(`  error: ${error}`);
}
log(`summary.json: ${summaryPath}`);
if (reports.some((report) => report.status === 'failed')) {
  process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function runCouncilScenario(): Promise<ScenarioReport> {
  const errors: string[] = [];
  const details: Record<string, unknown> = {};
  const backend = await startBackend('council');
  try {
    const before = await snapshotWorkspaceFiles();
    const prompt = [
      '在工作区实现一个最小的 TypeScript 工具函数文件。',
      '要求：创建 council-final.ts，导出函数 slugify(input: string): string，',
      '将任意字符串转换为小写连字符 slug。候选与最终文件都必须真实写入工作区。',
    ].join('');
    const created = await backend.request<{ run_id: string; task_id: string }>('run.create', {
      prompt,
      mode: 'council',
      workspace_path: options.workspace,
    });
    log(`council run created: ${created.run_id}`);
    await backend.subscribeAndLog(created.run_id);
    const snapshot = await backend.waitForTerminal(created.run_id, runTimeoutMs);
    const after = await snapshotWorkspaceFiles();
    const workspaceChanges = diffWorkspace(before, after);

    const council = asRecord(snapshot.council) ?? {};
    const proposals = Array.isArray(council.proposals) ? council.proposals : [];
    const runDir = path.join(repoRoot, '.newide', 'runs', created.run_id);
    const decision = await readJsonIfExists(path.join(runDir, 'council', 'decision.json'));
    const reviews = await readJsonIfExists(path.join(runDir, 'council', 'reviews.json'));
    const finalOutput = asRecord(snapshot.final_output) ?? {};

    details.run_id = created.run_id;
    details.task_id = created.task_id;
    details.status = snapshot.status;
    details.decision_id = council.decision_id ?? asRecord(decision)?.decision_id ?? null;
    details.verdict = council.verdict ?? null;
    details.decision_semantics =
      'CouncilDecision is advisory evidence; it is NOT a MergeAuthorization ' +
      '(can_create_merge_authorization=false).';
    details.can_create_merge_authorization = council.can_create_merge_authorization ?? null;
    details.proposal_count = proposals.length;
    details.review_count = Array.isArray(reviews) ? reviews.length : 0;
    details.selected_artifact_refs = council.selected_artifact_refs ?? [];
    details.response = finalOutput.response ?? '';
    details.session_id = finalOutput.session_id ?? null;
    details.changed_files = finalOutput.changed_files ?? [];
    details.files_written = finalOutput.files_written ?? [];
    details.tool_event_count = Array.isArray(finalOutput.tool_events)
      ? finalOutput.tool_events.length
      : 0;
    details.tool_events = finalOutput.tool_events ?? [];
    details.workspace_changes = workspaceChanges;
    details.council_files = {
      decision: path.join(runDir, 'council', 'decision.json'),
      proposals: path.join(runDir, 'council', 'proposals.json'),
      reviews: path.join(runDir, 'council', 'reviews.json'),
      synthesis: path.join(runDir, 'council', 'synthesis.json'),
      output: path.join(runDir, 'council', 'output.json'),
    };
    details.run_dir = runDir;
    details.errors_from_run = snapshot.errors ?? [];

    if (snapshot.status !== 'completed') {
      errors.push(`council run ended as ${String(snapshot.status)}`);
    }
    if (!decision) errors.push('council decision.json was not written');
    if (proposals.length === 0) errors.push('council snapshot has no proposals');
    if (workspaceChanges.length === 0) {
      errors.push('no real files were created or modified in the workspace');
    }

    const finalCandidate = workspaceChanges.find((file) => file.endsWith('council-final.ts'));
    details.final_candidate_file = finalCandidate ?? null;
    if (finalCandidate) {
      details.final_candidate_content = await fs.readFile(
        path.join(options.workspace, finalCandidate),
        'utf-8',
      );
    }

    log(`council decision_id: ${String(details.decision_id)}`);
    log(`council proposals: ${String(details.proposal_count)}`);
    log(`workspace changes: ${workspaceChanges.join(', ') || '(none)'}`);
  } catch (error) {
    errors.push(toMessage(error));
  } finally {
    await backend.close();
  }
  return {
    scenario: 'council',
    status: errors.length === 0 ? 'passed' : 'failed',
    details,
    errors,
  };
}

async function runSubagentScenario(): Promise<ScenarioReport> {
  const errors: string[] = [];
  const details: Record<string, unknown> = {};
  const backend = await startBackend('subagent');
  try {
    const before = await snapshotWorkspaceFiles();
    const prompt = [
      '这是一个 subagent 能力探针。你必须使用 Task 工具（subagent/子代理）来完成以下任务，',
      '而不是自己直接完成：派生一个子代理，让它在工作区创建 subagent-probe.txt，',
      '内容为一行 SUBAGENT_PROBE_OK。如果你无法使用 subagent，请直接创建该文件并在回复中说明原因。',
    ].join('');
    const created = await backend.request<{ run_id: string; task_id: string }>('run.create', {
      prompt,
      mode: 'single_agent',
      workspace_path: options.workspace,
    });
    log(`subagent probe run created: ${created.run_id}`);
    await backend.subscribeAndLog(created.run_id);
    const snapshot = await backend.waitForTerminal(created.run_id, runTimeoutMs);
    const after = await snapshotWorkspaceFiles();
    const workspaceChanges = diffWorkspace(before, after);

    const finalOutput = asRecord(snapshot.final_output) ?? {};
    const toolEvents = Array.isArray(finalOutput.tool_events) ? finalOutput.tool_events : [];
    // 只识别 A 真实上报的证据，绝不伪造 subagent 事件。
    const subagentEvidence = toolEvents.filter((event) => {
      const record = asRecord(event) ?? {};
      const haystack = [record.kind, record.title, record.tool_name, record.toolName]
        .filter((value): value is string => typeof value === 'string')
        .join(' ')
        .toLowerCase();
      return /subagent|sub-agent|\btask\b|\bagent\b/.test(haystack);
    });
    const subagentObserved = subagentEvidence.length > 0;

    details.run_id = created.run_id;
    details.status = snapshot.status;
    details.subagent_observed = subagentObserved;
    details.visibility = subagentObserved ? 'observable' : 'opaque';
    details.subagent_evidence = subagentEvidence;
    details.tool_event_count = toolEvents.length;
    details.tool_events_raw = toolEvents;
    details.response = finalOutput.response ?? '';
    details.session_id = finalOutput.session_id ?? null;
    details.changed_files = finalOutput.changed_files ?? [];
    details.workspace_changes = workspaceChanges;
    details.run_dir = path.join(repoRoot, '.newide', 'runs', created.run_id);
    details.errors_from_run = snapshot.errors ?? [];
    details.note =
      'Evidence above is the raw observable data returned by A. ' +
      'If A does not expose subagent identity, the backend cannot see it; we do not modify A.';

    const probeFile = workspaceChanges.find((file) => file.endsWith('subagent-probe.txt'));
    details.probe_file = probeFile ?? null;
    if (probeFile) {
      details.probe_file_content = await fs.readFile(
        path.join(options.workspace, probeFile),
        'utf-8',
      );
    }

    if (snapshot.status !== 'completed') {
      errors.push(`subagent probe run ended as ${String(snapshot.status)}`);
    }
    log(`subagent_observed=${String(subagentObserved)}`);
    log(`visibility=${subagentObserved ? 'observable' : 'opaque'}`);
    log(`tool events: ${String(toolEvents.length)}`);
    log(`workspace changes: ${workspaceChanges.join(', ') || '(none)'}`);
  } catch (error) {
    errors.push(toMessage(error));
  } finally {
    await backend.close();
  }
  return {
    scenario: 'subagent',
    status: errors.length === 0 ? 'passed' : 'failed',
    details,
    errors,
  };
}

async function runRestartScenario(): Promise<ScenarioReport> {
  const errors: string[] = [];
  const details: Record<string, unknown> = {};
  // 第一个后端进程：执行原始任务并落盘。
  const firstBackend = await startBackend('restart-first');
  let originalRunId = '';
  try {
    const prompt =
      '在工作区创建或覆盖 restart-proof.txt，内容为一行 RESTART_PROOF。不要创建其他文件。';
    const created = await firstBackend.request<{ run_id: string }>('run.create', {
      prompt,
      mode: 'single_agent',
      workspace_path: options.workspace,
    });
    originalRunId = created.run_id;
    log(`original run created: ${originalRunId}`);
    await firstBackend.subscribeAndLog(originalRunId);
    const snapshot = await firstBackend.waitForTerminal(originalRunId, runTimeoutMs);
    details.original_run_id = originalRunId;
    details.original_status = snapshot.status;
    const finalOutput = asRecord(snapshot.final_output) ?? {};
    details.original_session_id = finalOutput.session_id ?? null;
    if (snapshot.status !== 'completed') {
      errors.push(`original run ended as ${String(snapshot.status)}`);
    }
  } catch (error) {
    errors.push(toMessage(error));
  } finally {
    // 真实停止第一个后端进程。
    await firstBackend.close();
    log('first backend stopped');
  }

  if (errors.length > 0 || !originalRunId) {
    return { scenario: 'restart', status: 'failed', details, errors };
  }

  // 第二个后端进程：重启后从磁盘找到历史 run 并重新执行。
  const secondBackend = await startBackend('restart-second');
  try {
    const listed = await secondBackend.request<{ runs: Record<string, unknown>[] }>('run.list', {});
    const historical = listed.runs.find((entry) => entry.run_id === originalRunId);
    details.run_list_size = listed.runs.length;
    details.original_in_history = Boolean(historical);
    details.original_history_status = historical?.status ?? null;
    if (!historical) {
      errors.push('run.list after backend restart does not contain the original run');
    }

    const restarted = await secondBackend.request<{
      run_id: string;
      task_id: string;
      restarted_from_run_id: string;
      status: string;
    }>('run.restart', { run_id: originalRunId });
    log(`restarted as new run: ${restarted.run_id} (from ${restarted.restarted_from_run_id})`);
    await secondBackend.subscribeAndLog(restarted.run_id);
    const snapshot = await secondBackend.waitForTerminal(restarted.run_id, runTimeoutMs);
    const finalOutput = asRecord(snapshot.final_output) ?? {};

    details.new_run_id = restarted.run_id;
    details.restarted_from_run_id = restarted.restarted_from_run_id;
    details.new_status = snapshot.status;
    details.new_session_id = finalOutput.session_id ?? null;
    details.response = finalOutput.response ?? '';
    details.changed_files = finalOutput.changed_files ?? [];
    details.new_run_dir = path.join(repoRoot, '.newide', 'runs', restarted.run_id);
    details.original_run_dir = path.join(repoRoot, '.newide', 'runs', originalRunId);
    details.errors_from_run = snapshot.errors ?? [];

    const proofPath = path.join(options.workspace, 'restart-proof.txt');
    const proof = await fs.readFile(proofPath, 'utf-8').catch(() => undefined);
    details.proof_file = proofPath;
    details.proof_file_content = proof ?? null;

    if (restarted.run_id === originalRunId) {
      errors.push('run.restart reused the original run_id');
    }
    if (snapshot.status !== 'completed') {
      errors.push(`restarted run ended as ${String(snapshot.status)}`);
    }
    if (!proof?.includes('RESTART_PROOF')) {
      errors.push('restart-proof.txt does not contain RESTART_PROOF after the restarted run');
    }
    log(`original run: ${originalRunId} -> new run: ${restarted.run_id}`);
    log(`proof file: ${proofPath}`);
  } catch (error) {
    errors.push(toMessage(error));
  } finally {
    await secondBackend.close();
    log('second backend stopped');
  }
  return {
    scenario: 'restart',
    status: errors.length === 0 ? 'passed' : 'failed',
    details,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Backend process client
// ---------------------------------------------------------------------------

interface BackendClient {
  request<T>(method: string, params: unknown): Promise<T>;
  subscribeAndLog(runId: string): Promise<void>;
  waitForTerminal(runId: string, timeoutMs: number): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

async function startBackend(label: string): Promise<BackendClient> {
  const child: ChildProcess = spawn('pnpm', ['backend:rpc'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ACP_DRIVER_TIMEOUT_MS: process.env.ACP_DRIVER_TIMEOUT_MS ?? '300000',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stderr: string[] = [];
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(String(chunk)));
  const closed = new Promise<number | null>((resolve) => {
    child.once('error', () => resolve(null));
    child.once('close', (code) => resolve(code));
  });

  const messages: JsonRpcMessage[] = [];
  const waiters = new Set<{
    predicate: (message: JsonRpcMessage) => boolean;
    resolve: (message: JsonRpcMessage) => void;
  }>();
  createInterface({ input: child.stdout! }).on('line', (line) => {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return; // pnpm banner 或非 JSON 行
    }
    messages.push(message);
    for (const waiter of waiters) {
      if (!waiter.predicate(message)) continue;
      waiters.delete(waiter);
      waiter.resolve(message);
    }
  });

  let nextId = 1;
  const request = async <T>(method: string, params: unknown): Promise<T> => {
    const id = nextId++;
    const waiting = new Promise<JsonRpcMessage>((resolve, reject) => {
      const waiter = { predicate: (message: JsonRpcMessage) => message.id === id, resolve };
      waiters.add(waiter);
      setTimeout(() => {
        if (!waiters.delete(waiter)) return;
        reject(new Error(`[${label}] timed out waiting for ${method}. stderr=${stderr.join('')}`));
      }, 60_000).unref();
    });
    child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    const response = await waiting;
    if (response.error) {
      throw new Error(
        `[${label}] ${method}: ${String(response.error.code)} ${response.error.message}`,
      );
    }
    return response.result as T;
  };

  // 启动探活。
  await request('system.ping', {});
  log(`backend started (${label})`);

  return {
    request,
    subscribeAndLog: async (runId: string) => {
      await request('run.subscribe', { run_id: runId });
      const seen = new Set<string>();
      const logEvent = (message: JsonRpcMessage) => {
        const params = asRecord(message.params);
        if (params?.run_id !== runId) return;
        const event = asRecord(params.event);
        const type = typeof event?.type === 'string' ? event.type : undefined;
        if (!type || seen.has(String(event?.event_id))) return;
        seen.add(String(event?.event_id));
        if (
          /^(run\.|council\.|driver\.run_result|agent\.execution|gate\.result|worktree\.)/.test(
            type,
          )
        ) {
          log(`  event: ${type}`);
        }
      };
      for (const message of messages) {
        if (message.method === 'run.event') logEvent(message);
      }
      waiters.add({
        predicate: (message) => {
          if (message.method === 'run.event') logEvent(message);
          return false; // 永不消费，仅观察
        },
        resolve: () => undefined,
      });
    },
    waitForTerminal: async (runId: string, timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const snapshot = await request<Record<string, unknown>>('run.getSnapshot', {
          run_id: runId,
        });
        if (snapshot.status !== 'running') return snapshot;
        await sleep(1_000);
      }
      throw new Error(`[${label}] run ${runId} did not reach a terminal state`);
    },
    close: async () => {
      child.stdin?.end();
      const result = await Promise.race([closed, sleep(5_000).then(() => 'timeout' as const)]);
      if (result === 'timeout') {
        child.kill('SIGTERM');
        const terminated = await Promise.race([
          closed,
          sleep(2_000).then(() => 'timeout' as const),
        ]);
        if (terminated === 'timeout') child.kill('SIGKILL');
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function snapshotWorkspaceFiles(): Promise<Map<string, number>> {
  const files = new Map<string, number>();
  const walk = async (dir: string): Promise<void> => {
    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      if (dirent.name === '.newide' || dirent.name === 'node_modules' || dirent.name === '.git') {
        continue;
      }
      const fullPath = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        await walk(fullPath);
      } else if (dirent.isFile()) {
        const stat = await fs.stat(fullPath).catch(() => undefined);
        if (stat) files.set(path.relative(options.workspace, fullPath), stat.mtimeMs);
      }
    }
  };
  await walk(options.workspace);
  return files;
}

function diffWorkspace(before: Map<string, number>, after: Map<string, number>): string[] {
  const changed: string[] = [];
  for (const [file, mtime] of after) {
    const previous = before.get(file);
    if (previous === undefined || previous !== mtime) changed.push(file);
  }
  return changed.sort();
}

async function readJsonIfExists(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf-8'));
  } catch {
    return undefined;
  }
}

function parseCli(args: string[]): CliOptions {
  const workspaceIndex = args.indexOf('--workspace');
  const workspace = workspaceIndex >= 0 ? args[workspaceIndex + 1] : undefined;
  if (!workspace || !path.isAbsolute(workspace)) {
    throw new Error('--workspace must be an absolute path');
  }
  const scenarioIndex = args.indexOf('--scenario');
  const scenarioValue = scenarioIndex >= 0 ? (args[scenarioIndex + 1] ?? 'all') : 'all';
  const scenarios: Scenario[] =
    scenarioValue === 'all'
      ? ['council', 'subagent', 'restart']
      : scenarioValue === 'council' || scenarioValue === 'subagent' || scenarioValue === 'restart'
        ? [scenarioValue]
        : (() => {
            throw new Error(`Invalid --scenario value: ${scenarioValue}`);
          })();
  return { workspace: path.resolve(workspace), scenarios };
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received: ${value}`);
  }
  return parsed;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}
