/**
 * file-buffer-repository 单元测试
 *
 * 验证 FileBufferRepository 在应用状态目录下的持久化读写、
 * pending/processed/dead_letter 迁移，以及进程重启后的状态恢复。
 */
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { nowTimestamp } from '../../core';
import { FileBufferRepository } from '../adapters/file-buffer-repository';
import type { AgentContextSnapshot, BufferSnapshot, DriverReturn } from '../schemas';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createRepository(): Promise<{
  repo: FileBufferRepository;
  agentStateRoot: string;
}> {
  const agentStateRoot = await mkdtemp(join(tmpdir(), 'newide-buffer-'));
  tempDirs.push(agentStateRoot);
  return {
    repo: new FileBufferRepository({ agentStateRoot }),
    agentStateRoot,
  };
}

function sampleDriverReturn(): DriverReturn {
  return {
    artifacts: [],
    summary: 'Completed buffer persistence test task.',
    decisions: [],
    blockers: [],
    referenced_experiences: [],
    assumptions: [],
  };
}

function sampleBufferSnapshot(overrides: Partial<BufferSnapshot> = {}): BufferSnapshot {
  return {
    task_id: 'task_buffer_001',
    task_description: 'Implement FileBufferRepository.',
    driver_return: sampleDriverReturn(),
    source_task_id: 'task_buffer_001',
    source_driver: 'mock-driver',
    received_at: nowTimestamp(),
    retry_count: 0,
    extraction_status: 'pending',
    ...overrides,
  };
}

function sampleAgentContext(role_id: string): AgentContextSnapshot {
  return {
    snapshot_id: randomUUID(),
    source_task_id: 'task_buffer_001',
    agent_id: role_id,
    thinking_trace: 'Reasoning trace',
    planning_trace: 'Planning trace',
    driver_calls: [
      {
        call_id: 'call_001',
        driver_id: 'mock-driver',
        driver_return_ref: 'report_pending.json',
      },
    ],
    cleaned_at: nowTimestamp(),
    original_token_count: 1000,
    cleaned_token_count: 400,
    compression_ratio: 0.4,
  };
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function bufferPath(agentStateRoot: string, role_id: string, ...parts: string[]): string {
  return join(agentStateRoot, role_id, 'buffer', ...parts);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

describe('FileBufferRepository', () => {
  it('ensureAgent creates buffer directory layout and initial meta', async () => {
    const { repo, agentStateRoot } = await createRepository();
    const role_id = 'role_file_buffer';

    await repo.ensureAgent(role_id);

    const metaRaw = await readFile(
      join(agentStateRoot, role_id, 'buffer', 'buffer_meta.json'),
      'utf8',
    );
    const meta = JSON.parse(metaRaw) as { role_id: string; cursor: number; pending_count: number };

    expect(meta.role_id).toBe(role_id);
    expect(meta.cursor).toBe(0);
    expect(meta.pending_count).toBe(0);
  });

  it('saveBufferSnapshot writes pending files and increments seq', async () => {
    const { repo } = await createRepository();
    const role_id = 'role_save';
    await repo.ensureAgent(role_id);

    const agentContext = sampleAgentContext(role_id);
    const saved = await repo.saveBufferSnapshot(role_id, sampleBufferSnapshot(), agentContext);

    expect(saved.seq).toBe(1);
    expect(saved.snapshot.context_snapshot_ref).toBe('1');
    expect(saved.agent_context_snapshot?.driver_calls[0]?.driver_return_ref).toBe('report_1.json');

    const meta = await repo.getBufferMeta(role_id);
    expect(meta.cursor).toBe(1);
    expect(meta.pending_count).toBe(1);

    const pending = await repo.getPendingBuffer(role_id, 1);
    expect(pending?.snapshot.task_id).toBe('task_buffer_001');
    expect(pending?.agentContext?.agent_id).toBe(role_id);
  });

  it('listPendingBufferSeqs returns sorted seq list', async () => {
    const { repo } = await createRepository();
    const role_id = 'role_list';
    await repo.ensureAgent(role_id);

    await repo.saveBufferSnapshot(role_id, sampleBufferSnapshot({ task_id: 'task_1' }));
    await repo.saveBufferSnapshot(role_id, sampleBufferSnapshot({ task_id: 'task_2' }));
    await repo.saveBufferSnapshot(role_id, sampleBufferSnapshot({ task_id: 'task_3' }));

    await expect(repo.listPendingBufferSeqs(role_id)).resolves.toEqual([1, 2, 3]);
  });

  it('markBufferProcessed moves files to processed and updates meta', async () => {
    const { repo, agentStateRoot } = await createRepository();
    const role_id = 'role_processed';
    await repo.ensureAgent(role_id);

    await repo.saveBufferSnapshot(role_id, sampleBufferSnapshot(), sampleAgentContext(role_id));
    await repo.markBufferProcessed(role_id, 1);

    await expect(repo.getPendingBuffer(role_id, 1)).resolves.toBeUndefined();
    await expect(repo.listPendingBufferSeqs(role_id)).resolves.toEqual([]);

    const processedReport = await readFile(
      join(agentStateRoot, role_id, 'buffer', 'processed', 'report_1.json'),
      'utf8',
    );
    const snapshot = JSON.parse(processedReport) as BufferSnapshot;
    expect(snapshot.extraction_status).toBe('processed');

    const meta = await repo.getBufferMeta(role_id);
    expect(meta.pending_count).toBe(0);
    expect(meta.total_processed).toBe(1);
  });

  it('markBufferDeadLetter moves files to dead_letter and updates meta', async () => {
    const { repo, agentStateRoot } = await createRepository();
    const role_id = 'role_dead_letter';
    await repo.ensureAgent(role_id);

    await repo.saveBufferSnapshot(role_id, sampleBufferSnapshot());
    await repo.markBufferDeadLetter(role_id, 1);

    const deadLetterReport = await readFile(
      join(agentStateRoot, role_id, 'buffer', 'dead_letter', 'report_1.json'),
      'utf8',
    );
    const snapshot = JSON.parse(deadLetterReport) as BufferSnapshot;
    expect(snapshot.extraction_status).toBe('dead_letter');

    const meta = await repo.getBufferMeta(role_id);
    expect(meta.pending_count).toBe(0);
    expect(meta.total_dead_letters).toBe(1);
  });

  it('survives repository restart against the same agentStateRoot', async () => {
    const { repo, agentStateRoot } = await createRepository();
    const role_id = 'role_restart';
    await repo.ensureAgent(role_id);
    await repo.saveBufferSnapshot(role_id, sampleBufferSnapshot(), sampleAgentContext(role_id));

    const restarted = new FileBufferRepository({ agentStateRoot });
    await expect(restarted.listPendingBufferSeqs(role_id)).resolves.toEqual([1]);

    const pending = await restarted.getPendingBuffer(role_id, 1);
    expect(pending?.snapshot.task_id).toBe('task_buffer_001');
    expect(pending?.agentContext?.agent_id).toBe(role_id);

    const meta = await restarted.getBufferMeta(role_id);
    expect(meta.cursor).toBe(1);
    expect(meta.pending_count).toBe(1);
  });

  it('reconciles stale meta before save and never overwrites an existing report seq', async () => {
    const { repo, agentStateRoot } = await createRepository();
    const role_id = 'role_stale_meta';
    await repo.ensureAgent(role_id);

    const existing = sampleBufferSnapshot({ task_id: 'task_existing_7' });
    const existingPath = bufferPath(agentStateRoot, role_id, 'pending', 'report_7.json');
    await writeJson(existingPath, existing);
    await writeJson(bufferPath(agentStateRoot, role_id, 'buffer_meta.json'), {
      role_id,
      pending_count: 0,
      cursor: 0,
      total_processed: 0,
      total_dead_letters: 0,
    });

    const saved = await repo.saveBufferSnapshot(
      role_id,
      sampleBufferSnapshot({ task_id: 'task_new' }),
    );

    expect(saved.seq).toBe(8);
    expect(JSON.parse(await readFile(existingPath, 'utf8'))).toMatchObject({
      task_id: 'task_existing_7',
    });
    await expect(repo.listPendingBufferSeqs(role_id)).resolves.toEqual([7, 8]);
    await expect(repo.getBufferMeta(role_id)).resolves.toMatchObject({
      cursor: 8,
      pending_count: 2,
    });
  });

  it('does not reuse an orphan context seq left by an interrupted save', async () => {
    const { repo, agentStateRoot } = await createRepository();
    const role_id = 'role_orphan_context';
    await repo.ensureAgent(role_id);

    await writeJson(
      bufferPath(agentStateRoot, role_id, 'pending', 'context_11.json'),
      sampleAgentContext(role_id),
    );

    const saved = await repo.saveBufferSnapshot(role_id, sampleBufferSnapshot());

    expect(saved.seq).toBe(12);
    await expect(repo.getBufferMeta(role_id)).resolves.toMatchObject({
      cursor: 12,
      pending_count: 1,
    });
  });

  it('does not reuse an orphan terminal claim seq left by an interrupted mark', async () => {
    const { repo, agentStateRoot } = await createRepository();
    const role_id = 'role_orphan_terminal_claim';
    await repo.ensureAgent(role_id);

    await writeJson(bufferPath(agentStateRoot, role_id, 'terminal_claims', 'claim_13.json'), {
      seq: 13,
      target_status: 'processed',
    });

    const saved = await repo.saveBufferSnapshot(role_id, sampleBufferSnapshot());

    expect(saved.seq).toBe(14);
    await expect(repo.getBufferMeta(role_id)).resolves.toMatchObject({
      cursor: 14,
      pending_count: 1,
    });
  });

  it('serializes concurrent saves per role into unique monotonic seqs', async () => {
    const { repo } = await createRepository();
    const role_id = 'role_concurrent_save';
    await repo.ensureAgent(role_id);

    const results = await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        repo.saveBufferSnapshot(
          role_id,
          sampleBufferSnapshot({ task_id: `task_concurrent_${index}` }),
        ),
      ),
    );

    expect(results.map((result) => result.seq).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 16 }, (_, index) => index + 1),
    );
    await expect(repo.listPendingBufferSeqs(role_id)).resolves.toEqual(
      Array.from({ length: 16 }, (_, index) => index + 1),
    );
    await expect(repo.getBufferMeta(role_id)).resolves.toMatchObject({
      cursor: 16,
      pending_count: 16,
    });
  });

  it('preserves every committed report when two repository instances race', async () => {
    const { repo, agentStateRoot } = await createRepository();
    const competingRepo = new FileBufferRepository({ agentStateRoot });
    const role_id = 'role_cross_instance_save';
    await repo.ensureAgent(role_id);

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) => {
        const writer = index % 2 === 0 ? repo : competingRepo;
        return writer.saveBufferSnapshot(
          role_id,
          sampleBufferSnapshot({ task_id: `task_cross_instance_${index}` }),
        );
      }),
    );

    expect(new Set(results.map(({ seq }) => seq)).size).toBe(20);
    await expect(repo.listPendingBufferSeqs(role_id)).resolves.toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
    const taskIds = await Promise.all(
      Array.from({ length: 20 }, async (_, index) => {
        const pending = await repo.getPendingBuffer(role_id, index + 1);
        return pending?.snapshot.task_id;
      }),
    );
    expect(new Set(taskIds)).toEqual(
      new Set(Array.from({ length: 20 }, (_, index) => `task_cross_instance_${index}`)),
    );
  });

  it('finishes cleanup when target and pending files both exist after a crash', async () => {
    const { repo, agentStateRoot } = await createRepository();
    const role_id = 'role_replay_cleanup';
    await repo.ensureAgent(role_id);
    await repo.saveBufferSnapshot(role_id, sampleBufferSnapshot(), sampleAgentContext(role_id));

    const pendingReportPath = bufferPath(agentStateRoot, role_id, 'pending', 'report_1.json');
    const pendingContextPath = bufferPath(agentStateRoot, role_id, 'pending', 'context_1.json');
    const pendingSnapshot = JSON.parse(await readFile(pendingReportPath, 'utf8')) as BufferSnapshot;
    await writeJson(bufferPath(agentStateRoot, role_id, 'processed', 'report_1.json'), {
      ...pendingSnapshot,
      extraction_status: 'processed',
    });
    await writeFile(
      bufferPath(agentStateRoot, role_id, 'processed', 'context_1.json'),
      await readFile(pendingContextPath),
    );

    await repo.markBufferProcessed(role_id, 1);

    await expect(repo.getPendingBuffer(role_id, 1)).resolves.toBeUndefined();
    await expect(repo.getBufferMeta(role_id)).resolves.toMatchObject({
      pending_count: 0,
      total_processed: 1,
      total_dead_letters: 0,
    });
  });

  it('treats repeated markBufferProcessed as an idempotent no-op', async () => {
    const { repo } = await createRepository();
    const role_id = 'role_repeated_mark';
    await repo.ensureAgent(role_id);
    await repo.saveBufferSnapshot(role_id, sampleBufferSnapshot());

    await repo.markBufferProcessed(role_id, 1);
    await repo.markBufferProcessed(role_id, 1);

    await expect(repo.getBufferMeta(role_id)).resolves.toMatchObject({
      pending_count: 0,
      total_processed: 1,
      total_dead_letters: 0,
    });
  });

  it('allows same-status terminal claim replay across repository instances', async () => {
    const { repo, agentStateRoot } = await createRepository();
    const competingRepo = new FileBufferRepository({ agentStateRoot });
    const role_id = 'role_same_status_claim';
    await repo.ensureAgent(role_id);
    await repo.saveBufferSnapshot(role_id, sampleBufferSnapshot());

    await Promise.all([
      repo.markBufferProcessed(role_id, 1),
      competingRepo.markBufferProcessed(role_id, 1),
    ]);
    await competingRepo.markBufferProcessed(role_id, 1);

    await expect(repo.getBufferMeta(role_id)).resolves.toMatchObject({
      pending_count: 0,
      total_processed: 1,
      total_dead_letters: 0,
    });
    expect(
      JSON.parse(
        await readFile(
          bufferPath(agentStateRoot, role_id, 'terminal_claims', 'claim_1.json'),
          'utf8',
        ),
      ),
    ).toEqual({ seq: 1, target_status: 'processed' });
  });

  it('resumes a mark after the terminal claim committed but target publication did not', async () => {
    const { repo, agentStateRoot } = await createRepository();
    const role_id = 'role_claim_before_target_crash';
    await repo.ensureAgent(role_id);
    await repo.saveBufferSnapshot(role_id, sampleBufferSnapshot());
    await writeJson(bufferPath(agentStateRoot, role_id, 'terminal_claims', 'claim_1.json'), {
      seq: 1,
      target_status: 'dead_letter',
    });

    const restarted = new FileBufferRepository({ agentStateRoot });
    await restarted.markBufferDeadLetter(role_id, 1);

    await expect(restarted.getPendingBuffer(role_id, 1)).resolves.toBeUndefined();
    await expect(restarted.getBufferMeta(role_id)).resolves.toMatchObject({
      pending_count: 0,
      total_processed: 0,
      total_dead_letters: 1,
    });
    expect(
      await pathExists(bufferPath(agentStateRoot, role_id, 'dead_letter', 'report_1.json')),
    ).toBe(true);
  });

  it('uses one durable terminal claim when repository instances race opposite marks', async () => {
    const { repo, agentStateRoot } = await createRepository();
    const competingRepo = new FileBufferRepository({ agentStateRoot });

    for (let index = 0; index < 10; index += 1) {
      const role_id = `role_opposite_claim_${index}`;
      await repo.ensureAgent(role_id);
      await repo.saveBufferSnapshot(
        role_id,
        sampleBufferSnapshot({ task_id: `task_opposite_claim_${index}` }),
      );

      const outcomes = await Promise.allSettled([
        repo.markBufferProcessed(role_id, 1),
        competingRepo.markBufferDeadLetter(role_id, 1),
      ]);
      const fulfilled = outcomes.filter(
        (outcome): outcome is PromiseFulfilledResult<void> => outcome.status === 'fulfilled',
      );
      const rejected = outcomes.filter(
        (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
      );
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(String(rejected[0]?.reason)).toContain('Buffer already claimed');

      const processedExists = await pathExists(
        bufferPath(agentStateRoot, role_id, 'processed', 'report_1.json'),
      );
      const deadLetterExists = await pathExists(
        bufferPath(agentStateRoot, role_id, 'dead_letter', 'report_1.json'),
      );
      expect(Number(processedExists) + Number(deadLetterExists)).toBe(1);

      const claim = JSON.parse(
        await readFile(
          bufferPath(agentStateRoot, role_id, 'terminal_claims', 'claim_1.json'),
          'utf8',
        ),
      ) as { target_status: string };
      expect(claim.target_status).toBe(processedExists ? 'processed' : 'dead_letter');
      await expect(repo.getPendingBuffer(role_id, 1)).resolves.toBeUndefined();
      const meta = await repo.getBufferMeta(role_id);
      expect(meta.total_processed + meta.total_dead_letters).toBe(1);
    }
  });

  it('rejects an already-corrupt seq with both terminal targets', async () => {
    const { repo, agentStateRoot } = await createRepository();
    const role_id = 'role_dual_terminal_targets';
    await repo.ensureAgent(role_id);
    const saved = await repo.saveBufferSnapshot(role_id, sampleBufferSnapshot());

    await writeJson(bufferPath(agentStateRoot, role_id, 'processed', 'report_1.json'), {
      ...saved.snapshot,
      extraction_status: 'processed',
    });
    await writeJson(bufferPath(agentStateRoot, role_id, 'dead_letter', 'report_1.json'), {
      ...saved.snapshot,
      extraction_status: 'dead_letter',
    });

    await expect(repo.markBufferProcessed(role_id, 1)).rejects.toThrow(
      'Corrupt buffer terminal state: dual targets for seq=1',
    );
    await expect(repo.getPendingBuffer(role_id, 1)).resolves.toBeDefined();
  });

  it('reconciles cursor and counts from files after repository restart', async () => {
    const { repo, agentStateRoot } = await createRepository();
    const role_id = 'role_reconcile_restart';
    await repo.ensureAgent(role_id);

    await writeJson(
      bufferPath(agentStateRoot, role_id, 'pending', 'report_2.json'),
      sampleBufferSnapshot({ task_id: 'task_pending' }),
    );
    await writeJson(
      bufferPath(agentStateRoot, role_id, 'processed', 'report_4.json'),
      sampleBufferSnapshot({ task_id: 'task_processed', extraction_status: 'processed' }),
    );
    await writeJson(
      bufferPath(agentStateRoot, role_id, 'dead_letter', 'report_7.json'),
      sampleBufferSnapshot({ task_id: 'task_dead', extraction_status: 'dead_letter' }),
    );
    await writeJson(
      bufferPath(agentStateRoot, role_id, 'dead_letter', 'context_10.json'),
      sampleAgentContext(role_id),
    );
    await writeJson(bufferPath(agentStateRoot, role_id, 'buffer_meta.json'), {
      role_id,
      pending_count: 0,
      cursor: 1,
      total_processed: 0,
      total_dead_letters: 0,
    });

    const restarted = new FileBufferRepository({ agentStateRoot });
    await restarted.ensureAgent(role_id);

    await expect(restarted.getBufferMeta(role_id)).resolves.toMatchObject({
      cursor: 10,
      pending_count: 1,
      total_processed: 1,
      total_dead_letters: 1,
    });
    expect(
      JSON.parse(await readFile(bufferPath(agentStateRoot, role_id, 'buffer_meta.json'), 'utf8')),
    ).toMatchObject({
      cursor: 10,
      pending_count: 1,
      total_processed: 1,
      total_dead_letters: 1,
    });
  });

  it('rejects a conflicting same-seq target instead of overwriting it', async () => {
    const { repo, agentStateRoot } = await createRepository();
    const role_id = 'role_target_conflict';
    await repo.ensureAgent(role_id);
    await repo.saveBufferSnapshot(
      role_id,
      sampleBufferSnapshot({ task_id: 'task_pending_original' }),
    );

    const conflictingTarget = sampleBufferSnapshot({
      task_id: 'task_conflicting_target',
      extraction_status: 'processed',
    });
    const targetPath = bufferPath(agentStateRoot, role_id, 'processed', 'report_1.json');
    await writeJson(targetPath, conflictingTarget);

    await expect(repo.markBufferProcessed(role_id, 1)).rejects.toThrow(
      'Conflicting processed buffer target: seq=1',
    );
    expect(JSON.parse(await readFile(targetPath, 'utf8'))).toMatchObject({
      task_id: 'task_conflicting_target',
    });
    await expect(repo.getPendingBuffer(role_id, 1)).resolves.toBeDefined();
  });

  it('isolates buffer data by role_id under the same agentStateRoot', async () => {
    const { repo } = await createRepository();

    await repo.ensureAgent('role_a');
    await repo.ensureAgent('role_b');
    await repo.saveBufferSnapshot('role_a', sampleBufferSnapshot({ task_id: 'task_a' }));
    await repo.saveBufferSnapshot('role_b', sampleBufferSnapshot({ task_id: 'task_b' }));

    await expect(repo.listPendingBufferSeqs('role_a')).resolves.toEqual([1]);
    await expect(repo.listPendingBufferSeqs('role_b')).resolves.toEqual([1]);

    const pendingA = await repo.getPendingBuffer('role_a', 1);
    const pendingB = await repo.getPendingBuffer('role_b', 1);
    expect(pendingA?.snapshot.task_id).toBe('task_a');
    expect(pendingB?.snapshot.task_id).toBe('task_b');
  });

  it('throws when marking a missing pending buffer', async () => {
    const { repo } = await createRepository();
    const role_id = 'role_missing';
    await repo.ensureAgent(role_id);

    await expect(repo.markBufferProcessed(role_id, 99)).rejects.toThrow(
      'Pending buffer not found: seq=99',
    );
  });

  it('throws when reading meta before ensureAgent', async () => {
    const { repo } = await createRepository();

    await expect(repo.getBufferMeta('role_uninitialized')).rejects.toThrow(
      'Buffer store not found for agent: role_uninitialized',
    );
  });
});
