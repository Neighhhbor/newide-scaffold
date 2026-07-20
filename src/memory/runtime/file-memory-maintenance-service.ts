import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { nowTimestamp } from '../../core';
import { ExperienceRecordSchema, ExtractResultSchema } from '../schemas';
import type { AgentMemoryScope } from '../ports/agent-memory-scope';
import type {
  MemoryMaintenanceEnqueueRequest,
  MemoryMaintenanceQueue,
  MemoryMaintenanceReceipt,
  MemoryMaintenanceStatusQuery,
  MemoryMaintenanceStatusView,
} from '../ports/memory-maintenance-queue';
import type { ExperienceExtractorProcessor } from './experience-extractor-processor';
import type { SkillPromotionProcessor } from './skill-promotion-processor';

const JOB_SCHEMA_VERSION = 'memory-maintenance-job.v1' as const;
const JOB_REF_PATTERN = /^memory_maintenance_[0-9a-f]{24}$/;
const JOB_DIRECTORY = join('memory-maintenance', 'jobs');

const ExtractionCheckpointSchema = z.object({
  experiences: z.array(ExperienceRecordSchema),
  result: ExtractResultSchema,
});

const MemoryMaintenanceJobRecordSchema = z.object({
  schema_version: z.literal(JOB_SCHEMA_VERSION),
  ref: z.string().regex(JOB_REF_PATTERN),
  role_id: z.string().min(1),
  buffer_seq: z.number().int().positive(),
  task_id: z.string().min(1),
  run_id: z.string().min(1).optional(),
  recovered_from_buffer: z.boolean().optional(),
  status: z.enum(['pending', 'running', 'completed', 'failed']),
  phase: z.enum(['extraction', 'promotion']).optional(),
  attempts: z.number().int().min(0),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  started_at: z.iso.datetime().optional(),
  completed_at: z.iso.datetime().optional(),
  failed_at: z.iso.datetime().optional(),
  prepared_experiences: ExtractionCheckpointSchema.optional(),
  promotion_plan: z.object({ experience_ids: z.array(z.string()) }).optional(),
  result: z
    .object({
      experience_count: z.number().int().min(0),
      experience_ids: z.array(z.string()),
      skill_count: z.number().int().min(0),
      skill_ids: z.array(z.string()),
    })
    .optional(),
  error: z
    .object({
      phase: z.enum(['extraction', 'promotion']),
      name: z.string(),
      message: z.string(),
      retryable: z.boolean(),
    })
    .optional(),
});

export type MemoryMaintenanceJobRecord = z.infer<typeof MemoryMaintenanceJobRecordSchema>;

export interface FileMemoryMaintenanceServiceOptions {
  appStateRoot: string;
  listRoleIds: () => Promise<string[]>;
  memoryForRole: (roleId: string) => AgentMemoryScope;
  experienceProcessor: ExperienceExtractorProcessor;
  skillPromotionProcessor: SkillPromotionProcessor;
  closeTimeoutMs?: number;
}

export interface MemoryMaintenanceCloseResult {
  /** False means injected work is still in flight and dependencies must remain available. */
  drained: boolean;
}

export class FileMemoryMaintenanceService
  implements MemoryMaintenanceQueue, MemoryMaintenanceStatusQuery
{
  private readonly jobDirectory: string;
  private readonly closeTimeoutMs: number;
  private startPromise?: Promise<void>;
  private initialized = false;
  private closePromise?: Promise<MemoryMaintenanceCloseResult>;
  private storeTail: Promise<void> = Promise.resolve();
  private readonly jobWriteTails = new Map<string, Promise<void>>();
  private readonly roleTails = new Map<string, Promise<void>>();
  private readonly scheduledRefs = new Set<string>();
  private readonly backgroundTasks = new Set<Promise<void>>();
  private readonly backgroundErrors: unknown[] = [];
  private accepting = true;
  private detached = false;
  private pendingAfterClose = false;

  constructor(private readonly options: FileMemoryMaintenanceServiceOptions) {
    this.jobDirectory = join(options.appStateRoot, JOB_DIRECTORY);
    this.closeTimeoutMs = options.closeTimeoutMs ?? 5_000;
    if (!Number.isFinite(this.closeTimeoutMs) || this.closeTimeoutMs < 0) {
      throw new Error(`Invalid memory maintenance close timeout: ${String(this.closeTimeoutMs)}`);
    }
  }

  async start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    if (!this.accepting) throw new Error('Memory maintenance service is closed');

    this.startPromise = this.initializeAndReplay().then(() => {
      this.initialized = true;
    });
    return this.startPromise;
  }

  async enqueue(request: MemoryMaintenanceEnqueueRequest): Promise<MemoryMaintenanceReceipt> {
    if (!this.accepting) throw new Error('Memory maintenance service is closed');
    assertEnqueueRequest(request);

    const job = await this.withStoreLock(async () => {
      if (!this.accepting) throw new Error('Memory maintenance service is closed');
      await ensureDirectoryDurable(this.jobDirectory);
      const existing = await this.readJobByRef(
        memoryMaintenanceRef(request.role_id, request.buffer_seq),
      );
      if (existing) {
        const enriched = enrichRecoveredJob(existing, request);
        if (enriched === existing) return existing;
        return this.updateJob(existing.ref, (current) => enrichRecoveredJob(current, request));
      }
      const pending = await this.options
        .memoryForRole(request.role_id)
        .getPendingBuffer(request.buffer_seq);
      if (!pending) {
        throw new Error(
          `Pending buffer not found for memory maintenance: ${request.role_id}:${String(request.buffer_seq)}`,
        );
      }
      if (pending.snapshot.source_task_id !== request.task_id) {
        throw new Error(
          `Memory maintenance task does not match BufferSnapshot: ${request.task_id}`,
        );
      }
      const created = createPendingJob(request);
      await this.writeJob(created);
      return created;
    });

    if (!this.accepting) {
      this.pendingAfterClose = true;
      return { ref: job.ref };
    }
    if (this.initialized) {
      this.schedule(job);
    } else {
      void this.start().then(
        () => this.schedule(job),
        (error: unknown) => this.backgroundErrors.push(error),
      );
    }
    return { ref: job.ref };
  }

  async getJob(ref: string): Promise<MemoryMaintenanceJobRecord | undefined> {
    assertJobRef(ref);
    return this.readJobByRef(ref);
  }

  async getStatus(ref: string): Promise<MemoryMaintenanceStatusView | undefined> {
    const job = await this.getJob(ref);
    return job ? { ref: job.ref, status: job.status, updated_at: job.updated_at } : undefined;
  }

  getJobForBuffer(
    roleId: string,
    bufferSeq: number,
  ): Promise<MemoryMaintenanceJobRecord | undefined> {
    return this.getJob(memoryMaintenanceRef(roleId, bufferSeq));
  }

  async waitForIdle(): Promise<void> {
    await this.waitForIdleBarrier();
    if (this.backgroundErrors.length > 0) {
      throw new AggregateError(
        this.backgroundErrors.splice(0),
        'Memory maintenance background processing failed',
      );
    }
  }

  private async waitForIdleBarrier(): Promise<void> {
    if (this.accepting) {
      await this.startPromise;
      while (this.backgroundTasks.size > 0) {
        await Promise.all([...this.backgroundTasks]);
      }
    } else {
      await this.waitForClosedInstanceIdle();
    }
  }

  private async waitForClosedInstanceIdle(): Promise<void> {
    while (true) {
      const observedStoreTail = this.storeTail;
      await observedStoreTail;
      await this.startPromise;

      const observedWrites = [...this.jobWriteTails.values()];
      if (observedWrites.length > 0) await Promise.all(observedWrites);

      const observedTasks = [...this.backgroundTasks];
      if (observedTasks.length > 0) await Promise.all(observedTasks);

      if (
        observedStoreTail === this.storeTail &&
        this.jobWriteTails.size === 0 &&
        this.backgroundTasks.size === 0
      ) {
        return;
      }
    }
  }

  /**
   * Stops accepting work and waits up to closeTimeoutMs. A false result does not
   * cancel provider calls. Callers must keep dependencies alive and must not
   * start a replacement service until waitForIdle() resolves, or exit the process
   * so durable running/pending jobs can replay on the next start.
   */
  close(): Promise<MemoryMaintenanceCloseResult> {
    if (this.closePromise) return this.closePromise;
    this.accepting = false;
    this.closePromise = this.closeWithinBound();
    return this.closePromise;
  }

  private async initializeAndReplay(): Promise<void> {
    const jobs = await this.withStoreLock(async () => {
      await ensureDirectoryDurable(this.jobDirectory);
      await this.reconstructMissingJobs();
      const stored = await this.listJobs();
      const replayable: MemoryMaintenanceJobRecord[] = [];
      for (const job of stored) {
        if (job.status === 'pending') {
          replayable.push(job);
          continue;
        }
        if (job.status !== 'running') continue;
        if (job.error?.phase === 'extraction') {
          replayable.push(job);
          continue;
        }
        const pending = withoutTerminalFields({
          ...job,
          status: 'pending' as const,
          updated_at: nowTimestamp(),
        });
        await this.writeJob(pending);
        replayable.push(pending);
      }
      return replayable.sort(compareJobs);
    });

    for (const job of jobs) this.schedule(job);
  }

  private async reconstructMissingJobs(): Promise<void> {
    const roleIds = [...new Set(await this.options.listRoleIds())].sort(compareCodeUnits);
    for (const roleId of roleIds) {
      const memory = this.options.memoryForRole(roleId);
      const seqs = await memory.listPendingBufferSeqs();
      for (const bufferSeq of [...seqs].sort((left, right) => left - right)) {
        const ref = memoryMaintenanceRef(roleId, bufferSeq);
        if (await this.readJobByRef(ref)) continue;
        const pending = await memory.getPendingBuffer(bufferSeq);
        if (!pending) continue;
        await this.writeJob(
          createPendingJob({
            role_id: roleId,
            buffer_seq: bufferSeq,
            task_id: pending.snapshot.source_task_id,
            recovered_from_buffer: true,
          }),
        );
      }
    }
  }

  private schedule(job: MemoryMaintenanceJobRecord): void {
    if (job.status === 'completed' || job.status === 'failed' || this.scheduledRefs.has(job.ref)) {
      return;
    }
    this.scheduledRefs.add(job.ref);
    const previous = this.roleTails.get(job.role_id) ?? Promise.resolve();
    const running = previous.then(() => this.processJob(job.ref));
    const settled = running.catch((error: unknown) => {
      this.backgroundErrors.push(error);
    });
    this.roleTails.set(job.role_id, settled);
    this.backgroundTasks.add(settled);
    void settled.finally(() => {
      this.scheduledRefs.delete(job.ref);
      this.backgroundTasks.delete(settled);
      if (this.roleTails.get(job.role_id) === settled) {
        this.roleTails.delete(job.role_id);
      }
    });
  }

  private async processJob(ref: string): Promise<void> {
    if (this.detached) return;
    const storedJob = await this.readJobByRef(ref);
    if (!storedJob || storedJob.status === 'completed' || storedJob.status === 'failed') return;
    let job: MemoryMaintenanceJobRecord = storedJob;
    const memory = this.options.memoryForRole(job.role_id);

    if (job.status === 'running' && job.error?.phase === 'extraction') {
      await this.finishExtractionFailure(job, memory);
      return;
    }

    job = withoutTerminalFields({
      ...job,
      status: 'running',
      phase: 'extraction',
      attempts: job.attempts + 1,
      started_at: nowTimestamp(),
      updated_at: nowTimestamp(),
    });
    await this.writeJob(job);
    if (this.detached) return;

    let phase: 'extraction' | 'promotion' = 'extraction';
    try {
      const extracted = await this.options.experienceProcessor.extractOne(memory, job.buffer_seq, {
        ...(job.prepared_experiences
          ? {
              preparedExtraction: job.prepared_experiences,
              allowMissingPending: true,
            }
          : {}),
        onPrepared: async (prepared) => {
          if (this.detached) throw new MemoryMaintenanceDetachedError();
          job = {
            ...job,
            prepared_experiences: prepared,
            updated_at: nowTimestamp(),
          };
          await this.writeJob(job);
        },
        shouldContinue: () => !this.detached,
      });
      if (this.detached) return;

      phase = 'promotion';
      const extractionResult = {
        experience_count: extracted.extraction.experiences.length,
        experience_ids: extracted.extraction.experiences.map((experience) => experience.id),
        skill_count: 0,
        skill_ids: [],
      };
      job = {
        ...job,
        status: 'running',
        phase,
        prepared_experiences: extracted.extraction,
        result: extractionResult,
        updated_at: nowTimestamp(),
      };
      await this.writeJob(job);
      if (this.detached) return;

      const promotionPlan =
        job.promotion_plan ?? (await this.options.skillPromotionProcessor.planPromotions(memory));
      if (this.detached) return;
      job = {
        ...job,
        promotion_plan: promotionPlan,
        updated_at: nowTimestamp(),
      };
      await this.writeJob(job);
      if (this.detached) return;

      const promotions = await this.options.skillPromotionProcessor.executePromotionPlan(
        memory,
        promotionPlan,
        () => !this.detached,
      );
      if (this.detached) return;
      assertPromotionResults(promotions, job.role_id);
      const experienceIds = new Set(promotionPlan.experience_ids);
      const persistedSkills = (await memory.listSkills()).filter(
        (skill) => skill.promoted_from && experienceIds.has(skill.promoted_from),
      );
      if (this.detached) return;
      for (const skill of persistedSkills) {
        if (skill.review_status !== 'pending') {
          throw new Error(`Promoted Skill must remain pending: ${skill.id}`);
        }
        if (skill.agent_id !== job.role_id) {
          throw new Error(`Promoted Skill belongs to the wrong Agent: ${skill.id}`);
        }
      }
      const skillIds = persistedSkills.map((skill) => skill.id).sort(compareCodeUnits);
      const completedAt = nowTimestamp();
      job = {
        ...job,
        status: 'completed',
        result: {
          experience_count: extractionResult.experience_count,
          experience_ids: [...extractionResult.experience_ids],
          skill_count: skillIds.length,
          skill_ids: skillIds,
        },
        completed_at: completedAt,
        updated_at: completedAt,
      };
      await this.writeJob(job);
    } catch (error) {
      if (this.detached) return;
      const serialized = serializeError(error, phase);
      job = {
        ...job,
        status: 'running',
        phase,
        error: serialized,
        updated_at: nowTimestamp(),
      };
      await this.writeJob(job);
      if (this.detached) return;

      if (phase === 'extraction') {
        const pending = await memory.getPendingBuffer(job.buffer_seq);
        if (pending) await memory.markBufferDeadLetter(job.buffer_seq);
      }
      if (this.detached) return;

      const failedAt = nowTimestamp();
      await this.writeJob({
        ...job,
        status: 'failed',
        failed_at: failedAt,
        updated_at: failedAt,
      });
    }
  }

  private async finishExtractionFailure(
    job: MemoryMaintenanceJobRecord,
    memory: AgentMemoryScope,
  ): Promise<void> {
    if (this.detached) return;
    const pending = await memory.getPendingBuffer(job.buffer_seq);
    if (pending) await memory.markBufferDeadLetter(job.buffer_seq);
    if (this.detached) return;
    const failedAt = nowTimestamp();
    await this.writeJob({
      ...job,
      status: 'failed',
      failed_at: failedAt,
      updated_at: failedAt,
    });
  }

  private async closeWithinBound(): Promise<MemoryMaintenanceCloseResult> {
    const idle = this.waitForIdleBarrier();
    if (this.closeTimeoutMs === 0) {
      this.detached = true;
      return { drained: false };
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      idle.then(() => 'idle' as const),
      new Promise<'timeout'>((resolve) => {
        timeout = setTimeout(() => resolve('timeout'), this.closeTimeoutMs);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    if (outcome === 'timeout' || this.pendingAfterClose) this.detached = true;
    return { drained: outcome === 'idle' && !this.pendingAfterClose };
  }

  private async listJobs(): Promise<MemoryMaintenanceJobRecord[]> {
    const entries = await readdir(this.jobDirectory, { withFileTypes: true });
    const jobs: MemoryMaintenanceJobRecord[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const raw = await readFile(join(this.jobDirectory, entry.name), 'utf8');
      jobs.push(MemoryMaintenanceJobRecordSchema.parse(JSON.parse(raw)));
    }
    return jobs;
  }

  private async readJobByRef(ref: string): Promise<MemoryMaintenanceJobRecord | undefined> {
    try {
      const raw = await readFile(memoryMaintenanceJobPath(this.options.appStateRoot, ref), 'utf8');
      return MemoryMaintenanceJobRecordSchema.parse(JSON.parse(raw));
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  private writeJob(job: MemoryMaintenanceJobRecord): Promise<void> {
    const previous = this.jobWriteTails.get(job.ref) ?? Promise.resolve();
    const writing = previous.then(async () => {
      const current = await this.readJobByRef(job.ref);
      const withSourceIdentity =
        current?.run_id && !job.run_id ? { ...job, run_id: current.run_id } : job;
      await writeJsonAtomic(
        memoryMaintenanceJobPath(this.options.appStateRoot, job.ref),
        MemoryMaintenanceJobRecordSchema.parse(withSourceIdentity),
      );
    });
    const settled = writing.then(
      () => undefined,
      () => undefined,
    );
    this.jobWriteTails.set(job.ref, settled);
    void settled.then(() => {
      if (this.jobWriteTails.get(job.ref) === settled) this.jobWriteTails.delete(job.ref);
    });
    return writing;
  }

  private updateJob(
    ref: string,
    update: (current: MemoryMaintenanceJobRecord) => MemoryMaintenanceJobRecord,
  ): Promise<MemoryMaintenanceJobRecord> {
    const previous = this.jobWriteTails.get(ref) ?? Promise.resolve();
    const updating = previous.then(async () => {
      const current = await this.readJobByRef(ref);
      if (!current) throw new Error(`Memory maintenance job not found: ${ref}`);
      const updated = MemoryMaintenanceJobRecordSchema.parse(update(current));
      await writeJsonAtomic(memoryMaintenanceJobPath(this.options.appStateRoot, ref), updated);
      return updated;
    });
    const settled = updating.then(
      () => undefined,
      () => undefined,
    );
    this.jobWriteTails.set(ref, settled);
    void settled.then(() => {
      if (this.jobWriteTails.get(ref) === settled) this.jobWriteTails.delete(ref);
    });
    return updating;
  }

  private withStoreLock<T>(operation: () => Promise<T>): Promise<T> {
    const running = this.storeTail.then(operation, operation);
    this.storeTail = running.then(
      () => undefined,
      () => undefined,
    );
    return running;
  }
}

export function memoryMaintenanceRef(roleId: string, bufferSeq: number): string {
  if (!roleId || !Number.isInteger(bufferSeq) || bufferSeq <= 0) {
    throw new Error(`Invalid memory maintenance identity: ${roleId}:${String(bufferSeq)}`);
  }
  const digest = createHash('sha256')
    .update(`${roleId}\0${String(bufferSeq)}`)
    .digest('hex')
    .slice(0, 24);
  return `memory_maintenance_${digest}`;
}

export function memoryMaintenanceJobPath(appStateRoot: string, ref: string): string {
  assertJobRef(ref);
  return join(appStateRoot, JOB_DIRECTORY, `${ref}.json`);
}

class MemoryMaintenanceDetachedError extends Error {
  constructor() {
    super('Memory maintenance service detached after close timeout');
    this.name = 'MemoryMaintenanceDetachedError';
  }
}

function createPendingJob(request: {
  role_id: string;
  buffer_seq: number;
  task_id: string;
  run_id?: string;
  recovered_from_buffer?: boolean;
}): MemoryMaintenanceJobRecord {
  const timestamp = nowTimestamp();
  return {
    schema_version: JOB_SCHEMA_VERSION,
    ref: memoryMaintenanceRef(request.role_id, request.buffer_seq),
    role_id: request.role_id,
    buffer_seq: request.buffer_seq,
    task_id: request.task_id,
    ...(request.run_id ? { run_id: request.run_id } : {}),
    ...(request.recovered_from_buffer ? { recovered_from_buffer: true } : {}),
    status: 'pending',
    attempts: 0,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function enrichRecoveredJob(
  existing: MemoryMaintenanceJobRecord,
  request: MemoryMaintenanceEnqueueRequest,
): MemoryMaintenanceJobRecord {
  if (existing.role_id !== request.role_id || existing.buffer_seq !== request.buffer_seq) {
    throw new Error(`Memory maintenance ref collision: ${existing.ref}`);
  }
  if (existing.task_id !== request.task_id) {
    throw new Error(`Memory maintenance task mismatch: ${existing.ref}`);
  }
  if (existing.run_id && existing.run_id !== request.run_id) {
    throw new Error(`Memory maintenance run mismatch: ${existing.ref}`);
  }
  if (existing.run_id) return existing;
  return { ...existing, run_id: request.run_id, updated_at: nowTimestamp() };
}

function assertEnqueueRequest(request: MemoryMaintenanceEnqueueRequest): void {
  if (!request.task_id || !request.run_id) {
    throw new Error('Memory maintenance enqueue requires task_id and run_id');
  }
  memoryMaintenanceRef(request.role_id, request.buffer_seq);
}

function assertJobRef(ref: string): void {
  if (!JOB_REF_PATTERN.test(ref)) throw new Error(`Invalid memory maintenance ref: ${ref}`);
}

function assertPromotionResults(
  promotions: Awaited<ReturnType<SkillPromotionProcessor['checkAndPromote']>>,
  roleId: string,
): void {
  for (const promotion of promotions) {
    if (promotion.check.auto_approved) {
      throw new Error('Skill promotion must not be auto-approved');
    }
    if (!promotion.skill) continue;
    if (promotion.skill.review_status !== 'pending') {
      throw new Error(`Promoted Skill must remain pending: ${promotion.skill.id}`);
    }
    if (promotion.skill.agent_id !== roleId) {
      throw new Error(`Promoted Skill belongs to the wrong Agent: ${promotion.skill.id}`);
    }
  }
}

function serializeError(
  error: unknown,
  phase: 'extraction' | 'promotion',
): NonNullable<MemoryMaintenanceJobRecord['error']> {
  if (error instanceof Error) {
    return {
      phase,
      name: error.name,
      message: error.message,
      retryable: false,
    };
  }
  return {
    phase,
    name: 'Error',
    message: String(error),
    retryable: false,
  };
}

function withoutTerminalFields(job: MemoryMaintenanceJobRecord): MemoryMaintenanceJobRecord {
  const { completed_at: _completedAt, failed_at: _failedAt, error: _error, ...active } = job;
  return active;
}

function compareJobs(left: MemoryMaintenanceJobRecord, right: MemoryMaintenanceJobRecord): number {
  return compareCodeUnits(left.role_id, right.role_id) || left.buffer_seq - right.buffer_seq;
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await ensureDirectoryDurable(dirname(filePath));
  const temporaryPath = `${filePath}.${String(process.pid)}.${randomUUID()}.tmp`;
  let temporaryHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    temporaryHandle = await open(temporaryPath, 'wx', 0o600);
    await temporaryHandle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = undefined;
    await rename(temporaryPath, filePath);
    await syncDirectory(dirname(filePath));
  } catch (error) {
    await temporaryHandle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function ensureDirectoryDurable(directoryPath: string): Promise<void> {
  try {
    await mkdir(directoryPath);
  } catch (error) {
    if (isAlreadyExists(error)) return;
    if (!isNotFound(error)) throw error;
    const parent = dirname(directoryPath);
    if (parent === directoryPath) throw error;
    await ensureDirectoryDurable(parent);
    try {
      await mkdir(directoryPath);
    } catch (retryError) {
      if (isAlreadyExists(retryError)) return;
      throw retryError;
    }
  }
  await syncDirectory(directoryPath);
  await syncDirectory(dirname(directoryPath));
}

async function syncDirectory(directoryPath: string): Promise<void> {
  let directoryHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    directoryHandle = await open(directoryPath, 'r');
    await directoryHandle.sync();
  } catch (error) {
    if (!isUnsupportedDirectorySync(error)) throw error;
  } finally {
    await directoryHandle?.close().catch(() => undefined);
  }
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return ['EBADF', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM'].includes(
    String((error as { code?: unknown }).code),
  );
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'EEXIST'
  );
}
