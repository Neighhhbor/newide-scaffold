import { describe, expect, it } from 'vitest';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IntegrationV0Result } from '../../src/coordinator/integration-v0-flow';
import { NewideBackendService } from '../../src/app/newide-backend-service';
import { InMemoryRunRegistry } from '../../src/app/run-registry';
import { FileRunRequestStore, RunRequestNotFoundError } from '../../src/app/run-request-store';

describe('FileRunRequestStore', () => {
  it('persists requests and reports terminal or interrupted history without faking running', async () => {
    const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'run-request-store-'));
    const store = new FileRunRequestStore(runsRoot);
    try {
      await store.save({
        run_id: 'run_done',
        task_id: 'task_done',
        prompt: 'Finish the work',
        workspace_path: '/tmp/workspace-a',
        mode: 'single_agent',
        session_id: 'session_created_with',
      });
      await writeFile(
        path.join(runsRoot, 'run_done', 'frontend-snapshot.json'),
        JSON.stringify({
          status: 'completed',
          task_id: 'task_done',
          mode: 'single_agent',
          final_output: { status: 'completed', session_id: 'session_terminal' },
          errors: [],
        }),
        'utf-8',
      );
      await store.save({
        run_id: 'run_interrupted',
        task_id: 'task_interrupted',
        prompt: 'Crashed midway',
        workspace_path: '/tmp/workspace-b',
        mode: 'council',
      });
      // 只有残留文件、没有 request.json 也没有终态快照的目录不可诚实描述，应被跳过。
      await mkdir(path.join(runsRoot, 'run_stray'), { recursive: true });

      const history = await store.listHistory();
      expect(history.map((entry) => [entry.run_id, entry.status, entry.restartable])).toEqual(
        expect.arrayContaining([
          ['run_done', 'completed', true],
          ['run_interrupted', 'interrupted', true],
        ]),
      );
      expect(history).toHaveLength(2);
      await expect(store.readTerminalSessionId('run_done')).resolves.toBe('session_terminal');
      await expect(store.readTerminalSessionId('run_interrupted')).resolves.toBeUndefined();
      await expect(store.load('run_missing')).rejects.toBeInstanceOf(RunRequestNotFoundError);
    } finally {
      await rm(runsRoot, { recursive: true, force: true });
    }
  });
});

describe('NewideBackendService run history', () => {
  it('writes request.json on create and hides live runs from run.list', async () => {
    const runsRoot = await mkdtemp(path.join(os.tmpdir(), 'run-history-service-'));
    const requestStore = new FileRunRequestStore(runsRoot);
    const service = new NewideBackendService(
      {
        run: async (request) => {
          request.onRunCreated?.({ run_id: 'run_live', task_id: 'task_live' });
          return new Promise<IntegrationV0Result>(() => undefined);
        },
      },
      new InMemoryRunRegistry(),
      {
        initialize: async () => undefined,
        append: async () => undefined,
        flush: async () => undefined,
      },
      { finalize: async () => undefined },
      requestStore,
    );

    try {
      await service.createRun({
        prompt: 'Persist me',
        workspace_path: process.cwd(),
        mode: 'council',
        project_id: 'project_1',
        client_task_id: 'client_task_1',
      });
      await requestPersisted(runsRoot, 'run_live');

      const persisted = await requestStore.load('run_live');
      expect(persisted).toMatchObject({
        run_id: 'run_live',
        task_id: 'task_live',
        prompt: 'Persist me',
        mode: 'council',
        project_id: 'project_1',
        client_task_id: 'client_task_1',
        schema_version: 'v0',
      });
      expect(persisted.workspace_path).toBeTruthy();
      expect(persisted.created_at).toBeTruthy();

      // 运行中的 run 不出现在历史列表：它的真实状态由 run.getSnapshot 提供。
      const listed = await service.listRuns();
      expect(listed.runs.map((entry) => entry.run_id)).toEqual([]);
    } finally {
      await rm(runsRoot, { recursive: true, force: true });
    }
  });
});

async function requestPersisted(runsRoot: string, runId: string): Promise<void> {
  const requestPath = path.join(runsRoot, runId, 'request.json');
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await access(requestPath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error(`request.json was not persisted for ${runId}`);
}
