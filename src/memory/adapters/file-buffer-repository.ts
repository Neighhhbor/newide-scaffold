/**
 * FileBufferRepository — BufferRepository 文件持久化适配器
 *
 * 将 Agent 的 buffer 队列落盘至应用状态目录（非用户工作区）：
 * `{agentStateRoot}/{role_id}/buffer/` 下的 pending / processed / dead_letter。
 * 仅负责存储与状态迁移，不做经验提取；处理由 processPendingBuffer 等上层服务完成。
 */
import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  AgentContextSnapshotSchema,
  BufferMetaSchema,
  BufferSnapshotSchema,
  type AgentContextSnapshot,
  type BufferMeta,
  type BufferSnapshot,
} from '../schemas';
import type { BufferRepository, SaveBufferResult } from '../ports/buffer-repository';

/** FileBufferRepository 构造选项 */
export interface FileBufferRepositoryOptions {
  /** Agent 状态根目录，由 runtime 注入（非工作区路径） */
  agentStateRoot: string;
}

const BUFFER_DIR = 'buffer';
const META_FILE = 'buffer_meta.json';
const PENDING_DIR = 'pending';
const PROCESSED_DIR = 'processed';
const DEAD_LETTER_DIR = 'dead_letter';
const TERMINAL_CLAIMS_DIR = 'terminal_claims';

const REPORT_FILE_PATTERN = /^report_(\d+)\.json$/;
const CONTEXT_FILE_PATTERN = /^context_(\d+)\.json$/;
const TERMINAL_CLAIM_FILE_PATTERN = /^claim_(\d+)\.json$/;

type BufferTargetStatus = 'processed' | 'dead_letter';

interface BufferFilesystemState {
  cursor: number;
  pending_count: number;
  total_processed: number;
  total_dead_letters: number;
}

interface JsonPublication {
  destPath: string;
  data: unknown;
}

interface PreparedJsonPublication {
  destPath: string;
  tempPath: string;
}

interface BufferTerminalClaim {
  seq: number;
  target_status: BufferTargetStatus;
}

function createEmptyBufferMeta(role_id: string): BufferMeta {
  return {
    role_id,
    pending_count: 0,
    cursor: 0,
    total_processed: 0,
    total_dead_letters: 0,
  };
}

function assertSafeRoleId(role_id: string): void {
  if (!role_id || role_id.includes('/') || role_id.includes('\\') || role_id.includes('..')) {
    throw new Error(`Invalid role_id for buffer storage: ${role_id}`);
  }
}

function assertSafeSeq(seq: number): void {
  if (!Number.isSafeInteger(seq) || seq <= 0) {
    throw new Error(`Invalid buffer seq: ${seq}`);
  }
}

function reportFileName(seq: number): string {
  return `report_${seq}.json`;
}

function contextFileName(seq: number): string {
  return `context_${seq}.json`;
}

function terminalClaimFileName(seq: number): string {
  return `claim_${seq}.json`;
}

export class FileBufferRepository implements BufferRepository {
  private readonly agentStateRoot: string;
  private readonly roleMutationQueues = new Map<string, Promise<void>>();

  constructor(options: FileBufferRepositoryOptions) {
    this.agentStateRoot = options.agentStateRoot;
  }

  async ensureAgent(role_id: string): Promise<void> {
    assertSafeRoleId(role_id);
    await this.withRoleMutation(role_id, async () => {
      const bufferRoot = this.bufferRoot(role_id);
      await mkdir(join(bufferRoot, PENDING_DIR), { recursive: true });
      await mkdir(join(bufferRoot, PROCESSED_DIR), { recursive: true });
      await mkdir(join(bufferRoot, DEAD_LETTER_DIR), { recursive: true });
      await mkdir(join(bufferRoot, TERMINAL_CLAIMS_DIR), { recursive: true });
      await this.readAndReconcileBufferMeta(role_id, true);
    });
  }

  async saveBufferSnapshot(
    role_id: string,
    snapshot: BufferSnapshot,
    agentContext?: AgentContextSnapshot,
  ): Promise<SaveBufferResult> {
    assertSafeRoleId(role_id);
    return this.withRoleMutation(role_id, async () => {
      const bufferRoot = this.requireBufferRoot(role_id);

      for (;;) {
        const meta = await this.readAndReconcileBufferMeta(role_id, false);
        const seq = meta.cursor + 1;
        assertSafeSeq(seq);

        const storedSnapshot: BufferSnapshot = agentContext
          ? { ...snapshot, context_snapshot_ref: String(seq) }
          : snapshot;
        const validatedSnapshot = BufferSnapshotSchema.parse(storedSnapshot);

        const storedAgentContext = agentContext
          ? AgentContextSnapshotSchema.parse({
              ...agentContext,
              driver_calls: agentContext.driver_calls.map((call) => ({
                ...call,
                driver_return_ref: reportFileName(seq),
              })),
            })
          : undefined;

        const publications: JsonPublication[] = [];
        if (storedAgentContext) {
          publications.push({
            destPath: join(bufferRoot, PENDING_DIR, contextFileName(seq)),
            data: storedAgentContext,
          });
        }
        // report 是提交标记，必须在可选 context 之后发布。
        publications.push({
          destPath: join(bufferRoot, PENDING_DIR, reportFileName(seq)),
          data: validatedSnapshot,
        });

        if (!(await publishJsonSetExclusive(publications))) {
          // 另一个进程抢先使用了该 seq。重新扫描磁盘并分配更大的 seq。
          continue;
        }

        await this.reconcileBufferMeta(role_id, meta);
        return {
          seq,
          snapshot: validatedSnapshot,
          ...(storedAgentContext ? { agent_context_snapshot: storedAgentContext } : {}),
        };
      }
    });
  }

  async getBufferMeta(role_id: string): Promise<BufferMeta> {
    assertSafeRoleId(role_id);
    return this.withRoleMutation(role_id, () => this.readAndReconcileBufferMeta(role_id, false));
  }

  async markBufferProcessed(role_id: string, seq: number): Promise<void> {
    await this.markBuffer(role_id, seq, 'processed');
  }

  async markBufferDeadLetter(role_id: string, seq: number): Promise<void> {
    await this.markBuffer(role_id, seq, 'dead_letter');
  }

  async listPendingBufferSeqs(role_id: string): Promise<number[]> {
    const pendingDir = join(this.requireBufferRoot(role_id), PENDING_DIR);
    const entries = await readdirSafe(pendingDir);
    return collectReportSeqs(entries);
  }

  async getPendingBuffer(
    role_id: string,
    seq: number,
  ): Promise<{ snapshot: BufferSnapshot; agentContext?: AgentContextSnapshot } | undefined> {
    assertSafeSeq(seq);
    const bufferRoot = this.requireBufferRoot(role_id);
    const reportPath = join(bufferRoot, PENDING_DIR, reportFileName(seq));
    const rawReport = await readFileIfExists(reportPath);
    if (rawReport === undefined) {
      return undefined;
    }

    const snapshot = BufferSnapshotSchema.parse(JSON.parse(rawReport));
    const contextPath = join(bufferRoot, PENDING_DIR, contextFileName(seq));
    const rawContext = await readFileIfExists(contextPath);
    if (rawContext === undefined) {
      return { snapshot };
    }

    return {
      snapshot,
      agentContext: AgentContextSnapshotSchema.parse(JSON.parse(rawContext)),
    };
  }

  private bufferRoot(role_id: string): string {
    assertSafeRoleId(role_id);
    return join(this.agentStateRoot, role_id, BUFFER_DIR);
  }

  private requireBufferRoot(role_id: string): string {
    assertSafeRoleId(role_id);
    return join(this.agentStateRoot, role_id, BUFFER_DIR);
  }

  private async readAndReconcileBufferMeta(
    role_id: string,
    createIfMissing: boolean,
  ): Promise<BufferMeta> {
    const metaPath = join(this.requireBufferRoot(role_id), META_FILE);
    const raw = await readFileIfExists(metaPath);
    let meta: BufferMeta;

    if (raw === undefined) {
      if (!createIfMissing) {
        throw new Error(`Buffer store not found for agent: ${role_id}`);
      }
      meta = createEmptyBufferMeta(role_id);
    } else {
      meta = BufferMetaSchema.parse(JSON.parse(raw));
      if (meta.role_id !== role_id) {
        throw new Error(`Buffer meta role mismatch: expected=${role_id}, actual=${meta.role_id}`);
      }
    }

    return this.reconcileBufferMeta(role_id, meta, raw === undefined);
  }

  private async reconcileBufferMeta(
    role_id: string,
    meta: BufferMeta,
    forceWrite = false,
  ): Promise<BufferMeta> {
    const bufferRoot = this.requireBufferRoot(role_id);
    const state = await scanBufferFilesystem(bufferRoot);
    const reconciled = BufferMetaSchema.parse({
      ...meta,
      role_id,
      ...state,
    });

    if (forceWrite || !isDeepStrictEqual(meta, reconciled)) {
      await writeJsonAtomic(join(bufferRoot, META_FILE), reconciled);
    }

    return reconciled;
  }

  private async markBuffer(
    role_id: string,
    seq: number,
    targetStatus: BufferTargetStatus,
  ): Promise<void> {
    assertSafeRoleId(role_id);
    assertSafeSeq(seq);
    await this.withRoleMutation(role_id, async () => {
      const initialMeta = await this.readAndReconcileBufferMeta(role_id, false);
      const bufferRoot = this.requireBufferRoot(role_id);
      const targetDir = targetStatus === 'processed' ? PROCESSED_DIR : DEAD_LETTER_DIR;

      for (;;) {
        const pendingReportPath = join(bufferRoot, PENDING_DIR, reportFileName(seq));
        const pendingContextPath = join(bufferRoot, PENDING_DIR, contextFileName(seq));
        const targetReportPath = join(bufferRoot, targetDir, reportFileName(seq));
        const targetContextPath = join(bufferRoot, targetDir, contextFileName(seq));
        const processedReportPath = join(bufferRoot, PROCESSED_DIR, reportFileName(seq));
        const deadLetterReportPath = join(bufferRoot, DEAD_LETTER_DIR, reportFileName(seq));
        const claimPath = join(bufferRoot, TERMINAL_CLAIMS_DIR, terminalClaimFileName(seq));

        const [pendingReportRaw, processedReportRaw, deadLetterReportRaw, claimRaw] =
          await Promise.all([
            readFileIfExists(pendingReportPath),
            readFileIfExists(processedReportPath),
            readFileIfExists(deadLetterReportPath),
            readFileIfExists(claimPath),
          ]);

        if (processedReportRaw !== undefined && deadLetterReportRaw !== undefined) {
          throw new Error(`Corrupt buffer terminal state: dual targets for seq=${seq}`);
        }

        const existingTerminalStatus: BufferTargetStatus | undefined =
          processedReportRaw !== undefined
            ? 'processed'
            : deadLetterReportRaw !== undefined
              ? 'dead_letter'
              : undefined;

        if (pendingReportRaw === undefined && existingTerminalStatus === undefined) {
          throw new Error(`Pending buffer not found: seq=${seq}`);
        }

        const existingClaim =
          claimRaw === undefined ? undefined : parseTerminalClaim(claimRaw, seq);
        if (
          existingClaim &&
          existingTerminalStatus &&
          existingClaim.target_status !== existingTerminalStatus
        ) {
          throw new Error(
            `Corrupt buffer terminal state: claim=${existingClaim.target_status}, target=${existingTerminalStatus}, seq=${seq}`,
          );
        }

        if (!existingClaim) {
          const claim: BufferTerminalClaim = {
            seq,
            target_status: existingTerminalStatus ?? targetStatus,
          };
          if (!(await publishJsonSetExclusive([{ destPath: claimPath, data: claim }]))) {
            continue;
          }
          // 重新读取 claim 和目标，统一走已持有 claim 的校验路径。
          continue;
        }

        if (existingClaim.target_status !== targetStatus) {
          throw new Error(`Buffer already claimed ${existingClaim.target_status}: seq=${seq}`);
        }

        const targetReportRaw =
          targetStatus === 'processed' ? processedReportRaw : deadLetterReportRaw;

        const expectedTarget =
          pendingReportRaw === undefined
            ? undefined
            : BufferSnapshotSchema.parse({
                ...BufferSnapshotSchema.parse(JSON.parse(pendingReportRaw)),
                extraction_status: targetStatus,
              });
        const existingTarget =
          targetReportRaw === undefined
            ? undefined
            : BufferSnapshotSchema.parse(JSON.parse(targetReportRaw));

        if (existingTarget && existingTarget.extraction_status !== targetStatus) {
          throw new Error(`Conflicting ${targetStatus} buffer target: seq=${seq}`);
        }
        if (
          existingTarget &&
          expectedTarget &&
          !isDeepStrictEqual(existingTarget, expectedTarget)
        ) {
          throw new Error(`Conflicting ${targetStatus} buffer target: seq=${seq}`);
        }

        const pendingContextRaw = await readFileIfExists(pendingContextPath);
        const targetContextRaw = await readFileIfExists(targetContextPath);
        const pendingContext =
          pendingContextRaw === undefined
            ? undefined
            : AgentContextSnapshotSchema.parse(JSON.parse(pendingContextRaw));
        const existingTargetContext =
          targetContextRaw === undefined
            ? undefined
            : AgentContextSnapshotSchema.parse(JSON.parse(targetContextRaw));

        if (
          pendingContext &&
          existingTargetContext &&
          !isDeepStrictEqual(pendingContext, existingTargetContext)
        ) {
          throw new Error(`Conflicting ${targetStatus} buffer context target: seq=${seq}`);
        }

        const publications: JsonPublication[] = [];
        if (pendingContext && !existingTargetContext) {
          publications.push({ destPath: targetContextPath, data: pendingContext });
        }
        if (expectedTarget && !existingTarget) {
          // target report 仍是状态迁移的提交标记，最后发布。
          publications.push({ destPath: targetReportPath, data: expectedTarget });
        }

        if (publications.length > 0 && !(await publishJsonSetExclusive(publications))) {
          // 目标在预检后由并发调用创建；重新读取并做内容一致性校验。
          continue;
        }

        await unlinkIfExists(pendingReportPath);
        await unlinkIfExists(pendingContextPath);
        await this.reconcileBufferMeta(role_id, initialMeta);
        return;
      }
    });
  }

  private async withRoleMutation<T>(role_id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.roleMutationQueues.get(role_id) ?? Promise.resolve();
    const running = previous.then(operation, operation);
    const completed = running.then(
      () => undefined,
      () => undefined,
    );
    this.roleMutationQueues.set(role_id, completed);

    try {
      return await running;
    } finally {
      if (this.roleMutationQueues.get(role_id) === completed) {
        this.roleMutationQueues.delete(role_id);
      }
    }
  }
}

async function scanBufferFilesystem(bufferRoot: string): Promise<BufferFilesystemState> {
  const [pendingEntries, processedEntries, deadLetterEntries, terminalClaimEntries] =
    await Promise.all([
      readdirSafe(join(bufferRoot, PENDING_DIR)),
      readdirSafe(join(bufferRoot, PROCESSED_DIR)),
      readdirSafe(join(bufferRoot, DEAD_LETTER_DIR)),
      readdirOrEmpty(join(bufferRoot, TERMINAL_CLAIMS_DIR)),
    ]);

  const allPayloadEntries = [...pendingEntries, ...processedEntries, ...deadLetterEntries];
  let cursor = 0;
  for (const entry of allPayloadEntries) {
    const seq = sequenceFromPayloadFile(entry);
    if (seq !== undefined) {
      cursor = Math.max(cursor, seq);
    }
  }
  for (const entry of terminalClaimEntries) {
    const seq = sequenceFromTerminalClaimFile(entry);
    if (seq !== undefined) {
      cursor = Math.max(cursor, seq);
    }
  }

  return {
    cursor,
    pending_count: collectReportSeqs(pendingEntries).length,
    total_processed: collectReportSeqs(processedEntries).length,
    total_dead_letters: collectReportSeqs(deadLetterEntries).length,
  };
}

function collectReportSeqs(entries: string[]): number[] {
  const seqs: number[] = [];
  for (const entry of entries) {
    const match = REPORT_FILE_PATTERN.exec(entry);
    if (!match) {
      continue;
    }
    const seq = parseStoredSeq(match[1], entry);
    seqs.push(seq);
  }
  return seqs.sort((a, b) => a - b);
}

function sequenceFromPayloadFile(entry: string): number | undefined {
  const match = REPORT_FILE_PATTERN.exec(entry) ?? CONTEXT_FILE_PATTERN.exec(entry);
  return match ? parseStoredSeq(match[1], entry) : undefined;
}

function sequenceFromTerminalClaimFile(entry: string): number | undefined {
  const match = TERMINAL_CLAIM_FILE_PATTERN.exec(entry);
  return match ? parseStoredSeq(match[1], entry) : undefined;
}

function parseStoredSeq(raw: string | undefined, entry: string): number {
  const seq = Number(raw);
  if (!Number.isSafeInteger(seq) || seq <= 0) {
    throw new Error(`Invalid buffer payload sequence in file: ${entry}`);
  }
  return seq;
}

async function readdirSafe(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      throw new Error(`Buffer store not found for agent directory: ${dir}`);
    }
    throw error;
  }
}

async function readdirOrEmpty(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return [];
    }
    throw error;
  }
}

function parseTerminalClaim(raw: string, expectedSeq: number): BufferTerminalClaim {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`Invalid buffer terminal claim: seq=${expectedSeq}`);
  }

  const claim = parsed as Record<string, unknown>;
  if (
    claim.seq !== expectedSeq ||
    (claim.target_status !== 'processed' && claim.target_status !== 'dead_letter')
  ) {
    throw new Error(`Invalid buffer terminal claim: seq=${expectedSeq}`);
  }

  return {
    seq: expectedSeq,
    target_status: claim.target_status,
  };
}

async function readFileIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return undefined;
    }
    throw error;
  }
}

async function unlinkIfExists(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) {
      throw error;
    }
  }
}

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const prepared = await prepareJsonPublication(filePath, data);
  try {
    await rename(prepared.tempPath, filePath);
    await syncDirectory(dirname(filePath));
  } finally {
    await unlinkIfExists(prepared.tempPath);
  }
}

/**
 * 将同一 payload 集合以不可覆盖方式发布。调用方应把 commit marker 放在最后。
 * 任一目标已存在时，只回滚本次进程创建且 inode 仍匹配的 hard link。
 */
async function publishJsonSetExclusive(publications: JsonPublication[]): Promise<boolean> {
  if (publications.length === 0) {
    return true;
  }

  const prepared: PreparedJsonPublication[] = [];
  const linkedPublications: PreparedJsonPublication[] = [];
  try {
    for (const publication of publications) {
      prepared.push(await prepareJsonPublication(publication.destPath, publication.data));
    }

    try {
      for (const publication of prepared) {
        await link(publication.tempPath, publication.destPath);
        linkedPublications.push(publication);
      }
      await syncDirectories(prepared.map(({ destPath }) => dirname(destPath)));
    } catch (publicationError) {
      try {
        await rollbackLinkedPublications(linkedPublications);
      } catch (rollbackError) {
        throw new AggregateError(
          [publicationError, rollbackError],
          'Failed to publish JSON set and roll back linked destinations',
        );
      }

      if (hasErrorCode(publicationError, 'EEXIST')) {
        return false;
      }
      throw publicationError;
    }

    return true;
  } finally {
    await Promise.all(prepared.map(({ tempPath }) => unlinkIfExists(tempPath)));
  }
}

async function rollbackLinkedPublications(
  linkedPublications: PreparedJsonPublication[],
): Promise<void> {
  const rollbackErrors: unknown[] = [];
  for (const publication of [...linkedPublications].reverse()) {
    try {
      await unlinkIfSameInode(publication.destPath, publication.tempPath);
    } catch (error) {
      rollbackErrors.push(error);
    }
  }

  try {
    await syncDirectories(linkedPublications.map(({ destPath }) => dirname(destPath)));
  } catch (error) {
    rollbackErrors.push(error);
  }

  if (rollbackErrors.length > 0) {
    throw new AggregateError(rollbackErrors, 'Failed to roll back JSON set publication');
  }
}

async function prepareJsonPublication(
  destPath: string,
  data: unknown,
): Promise<PreparedJsonPublication> {
  await mkdir(dirname(destPath), { recursive: true });
  const tempPath = `${destPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(tempPath, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    await unlinkIfExists(tempPath);
    throw error;
  }

  return { destPath, tempPath };
}

async function unlinkIfSameInode(destPath: string, tempPath: string): Promise<void> {
  const [destStat, tempStat] = await Promise.all([
    stat(destPath).catch((error: unknown) => {
      if (hasErrorCode(error, 'ENOENT')) {
        return undefined;
      }
      throw error;
    }),
    stat(tempPath),
  ]);

  if (destStat && destStat.dev === tempStat.dev && destStat.ino === tempStat.ino) {
    await unlinkIfExists(destPath);
  }
}

async function syncDirectories(directories: string[]): Promise<void> {
  for (const directory of new Set(directories)) {
    await syncDirectory(directory);
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, 'r');
  } catch (error) {
    if (isUnsupportedDirectorySyncError(error)) {
      return;
    }
    throw error;
  }

  try {
    await handle.sync();
  } catch (error) {
    // 某些平台不允许 fsync 目录；文件自身已经在发布前完成 fsync。
    if (!isUnsupportedDirectorySyncError(error)) {
      throw error;
    }
  } finally {
    await handle.close();
  }
}

function hasErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}

function isUnsupportedDirectorySyncError(error: unknown): boolean {
  return ['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].some((code) => hasErrorCode(error, code));
}
