import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nowTimestamp } from '../../core';
import { createAgentMemoryScope } from '../adapters/agent-memory-scope';
import { AlwaysExtractPolicy } from '../adapters/always-extract-policy';
import { DefaultPromotionTriggerPolicy } from '../adapters/default-promotion-trigger-policy';
import { InMemoryBufferRepository } from '../adapters/in-memory-buffer-repository';
import { InMemoryRepository } from '../adapters/in-memory-repository';
import type { ExperienceExtractor } from '../ports/experience-extractor';
import type { AgentMemoryScope } from '../ports/agent-memory-scope';
import { ExperienceExtractorProcessor } from '../runtime/experience-extractor-processor';
import {
  FileMemoryMaintenanceService,
  memoryMaintenanceJobPath,
} from '../runtime/file-memory-maintenance-service';
import {
  SkillPromotionProcessor,
  type SkillPromotionPlan,
} from '../runtime/skill-promotion-processor';
import type { BufferSnapshot, ExperienceRecord, SkillRecord } from '../schemas';
import { ruleBasedSkillPromotion } from '../services/skill-promotion';
import type { ExtractionOutput } from '../types';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('FileMemoryMaintenanceService', () => {
  it('persists the receipt before enqueue resolves and completes asynchronously', async () => {
    const infrastructure = await createInfrastructure('role_receipt');
    const extraction = deferred<void>();
    const extractor = createExtractor({ beforeReturn: () => extraction.promise });
    const service = await createService(infrastructure, extractor);

    const receipt = await service.enqueue({
      role_id: infrastructure.roleId,
      buffer_seq: 1,
      task_id: 'task_role_receipt',
      run_id: 'run_receipt',
    });

    const persisted = JSON.parse(
      await readFile(memoryMaintenanceJobPath(infrastructure.appStateRoot, receipt.ref), 'utf8'),
    ) as { ref: string; status: string };
    expect(persisted.ref).toBe(receipt.ref);
    expect(['pending', 'running']).toContain(persisted.status);
    await expect(service.getStatus(receipt.ref)).resolves.toMatchObject({
      ref: receipt.ref,
      status: expect.stringMatching(/^(pending|running)$/),
    });

    extraction.resolve();
    await service.waitForIdle();

    await expect(service.getJob(receipt.ref)).resolves.toMatchObject({
      status: 'completed',
      result: { experience_count: 1, skill_count: 1 },
    });
    await expect(service.getStatus(receipt.ref)).resolves.toMatchObject({ status: 'completed' });
    await expect(service.close()).resolves.toEqual({ drained: true });
    await expect(service.close()).resolves.toEqual({ drained: true });
  });

  it('is idempotent when the same role and buffer sequence are enqueued twice', async () => {
    const infrastructure = await createInfrastructure('role_idempotent');
    const release = deferred<void>();
    const extract = vi.fn(createExtractor({ beforeReturn: () => release.promise }).extract);
    const service = await createService(infrastructure, { extract });
    const request = {
      role_id: infrastructure.roleId,
      buffer_seq: 1,
      task_id: 'task_role_idempotent',
      run_id: 'run_idempotent',
    };

    const [first, second] = await Promise.all([service.enqueue(request), service.enqueue(request)]);
    expect(first).toEqual(second);

    release.resolve();
    await service.waitForIdle();
    expect(extract).toHaveBeenCalledTimes(1);
    await expect(service.getJob(first.ref)).resolves.toMatchObject({
      status: 'completed',
      attempts: 1,
    });
  });

  it('processes only the requested buffer sequence and normalizes Agent ownership', async () => {
    const infrastructure = await createInfrastructure('role_exact');
    const extractor = createExtractor({ agentId: 'task-id-is-not-an-agent' });
    const service = await createService(infrastructure, extractor);
    await service.start();
    await service.waitForIdle();
    await writePendingBuffer(infrastructure.memory, 'task_unrequested');
    await writePendingBuffer(infrastructure.memory, 'task_second');

    await service.enqueue({
      role_id: infrastructure.roleId,
      buffer_seq: 3,
      task_id: 'task_second',
      run_id: 'run_second',
    });
    await service.waitForIdle();

    expect(await infrastructure.memory.listPendingBufferSeqs()).toEqual([2]);
    const experiences = await infrastructure.memory.listExperiences();
    expect(experiences).toHaveLength(2);
    const secondExperience = experiences.find(
      (experience) => experience.source_task_id === 'task_second',
    );
    expect(secondExperience).toMatchObject({
      agent_id: infrastructure.roleId,
      source_task_id: 'task_second',
    });
    expect(secondExperience!.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('keeps promoted Skills pending and records auto approval as false', async () => {
    const infrastructure = await createInfrastructure('role_pending_skill');
    const service = await createService(infrastructure, createExtractor());

    const receipt = await service.enqueue({
      role_id: infrastructure.roleId,
      buffer_seq: 1,
      task_id: 'task_role_pending_skill',
      run_id: 'run_pending_skill',
    });
    await service.waitForIdle();

    const skills = await infrastructure.memory.listSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      agent_id: infrastructure.roleId,
      review_status: 'pending',
    });
    await expect(service.getJob(receipt.ref)).resolves.toMatchObject({
      status: 'completed',
      result: { skill_ids: [skills[0]!.id] },
    });
  });

  it('persists and accounts for the accumulated role-wide promotion plan', async () => {
    const infrastructure = await createInfrastructure('role_accumulated_promotion');
    const now = nowTimestamp();
    const historicalExperiences = Array.from({ length: 4 }, (_, index) =>
      createStoredExperience(infrastructure.roleId, `task_historical_${String(index)}`, now, 0.96),
    );
    for (const experience of historicalExperiences) {
      await infrastructure.memory.saveExperience(experience);
    }
    const service = await createService(infrastructure, createExtractor({ confidence: 0.96 }));

    const receipt = await service.enqueue({
      role_id: infrastructure.roleId,
      buffer_seq: 1,
      task_id: 'task_role_accumulated_promotion',
      run_id: 'run_accumulated_promotion',
    });
    await service.waitForIdle();

    const skills = await infrastructure.memory.listSkills();
    expect(skills).toHaveLength(5);
    expect(skills.every((skill) => skill.review_status === 'pending')).toBe(true);
    expect((await infrastructure.memory.listExperiences()).every((item) => item.promoted_to)).toBe(
      true,
    );
    const skillIds = skills.map((skill) => skill.id).sort();
    await expect(service.getJob(receipt.ref)).resolves.toMatchObject({
      promotion_plan: {
        experience_ids: expect.arrayContaining(historicalExperiences.map((e) => e.id)),
      },
      result: { skill_count: 5, skill_ids: skillIds },
    });
  });

  it('dead-letters an extraction failure but keeps a promotion failure independent', async () => {
    const extractionInfra = await createInfrastructure('role_extract_failure');
    const extractionService = await createService(extractionInfra, {
      extract: vi.fn().mockRejectedValue(new Error('extractor unavailable')),
    });

    const extractionReceipt = await extractionService.enqueue({
      role_id: extractionInfra.roleId,
      buffer_seq: 1,
      task_id: 'task_role_extract_failure',
      run_id: 'run_extract_failure',
    });
    await extractionService.waitForIdle();

    expect(await extractionInfra.memory.getBufferMeta()).toMatchObject({
      pending_count: 0,
      total_processed: 0,
      total_dead_letters: 1,
    });
    await expect(extractionService.getJob(extractionReceipt.ref)).resolves.toMatchObject({
      status: 'failed',
      error: { phase: 'extraction', retryable: false, message: 'extractor unavailable' },
    });

    const promotionInfra = await createInfrastructure('role_promotion_failure');
    const promotionService = await createService(promotionInfra, createExtractor(), async () => {
      throw new Error('promoter unavailable');
    });
    const promotionReceipt = await promotionService.enqueue({
      role_id: promotionInfra.roleId,
      buffer_seq: 1,
      task_id: 'task_role_promotion_failure',
      run_id: 'run_promotion_failure',
    });
    await promotionService.waitForIdle();

    expect(await promotionInfra.memory.getBufferMeta()).toMatchObject({
      pending_count: 0,
      total_processed: 1,
      total_dead_letters: 0,
    });
    expect(await promotionInfra.memory.listExperiences()).toHaveLength(1);
    await expect(promotionService.getJob(promotionReceipt.ref)).resolves.toMatchObject({
      status: 'failed',
      error: { phase: 'promotion', retryable: false, message: 'promoter unavailable' },
    });
  });

  it('replays crash-left running and pending jobs in role/sequence order', async () => {
    const infrastructure = await createInfrastructure('role_replay');
    await writePendingBuffer(infrastructure.memory, 'task_replay_2');
    const firstStarted = deferred<void>();
    const neverFinishes = deferred<void>();
    const firstExtractor = createExtractor({
      beforeReturn: () => {
        firstStarted.resolve();
        return neverFinishes.promise;
      },
    });
    const firstService = await createService(infrastructure, firstExtractor, undefined, 5);

    await firstService.enqueue({
      role_id: infrastructure.roleId,
      buffer_seq: 1,
      task_id: 'task_role_replay',
      run_id: 'run_replay_1',
    });
    await firstService.enqueue({
      role_id: infrastructure.roleId,
      buffer_seq: 2,
      task_id: 'task_replay_2',
      run_id: 'run_replay_2',
    });
    await firstStarted.promise;
    await firstService.close();

    const observedTasks: string[] = [];
    const replayExtractor = createExtractor({
      onExtract: (snapshot) => observedTasks.push(snapshot.task_id),
    });
    const replayService = await createService(infrastructure, replayExtractor);
    await replayService.start();
    await replayService.waitForIdle();

    expect(observedTasks).toEqual(['task_role_replay', 'task_replay_2']);
    expect(await infrastructure.memory.listPendingBufferSeqs()).toEqual([]);
  });

  it('reconstructs a missing job from a durable pending buffer on startup', async () => {
    const infrastructure = await createInfrastructure('role_missing_job');
    const service = await createService(infrastructure, createExtractor());

    await service.start();
    await service.waitForIdle();

    const job = await service.getJobForBuffer(infrastructure.roleId, 1);
    expect(job).toMatchObject({
      status: 'completed',
      role_id: infrastructure.roleId,
      buffer_seq: 1,
      task_id: 'task_role_missing_job',
      recovered_from_buffer: true,
    });
    expect(job).not.toHaveProperty('run_id');
  });

  it('reuses an extraction checkpoint after a crash without duplicating Experience records', async () => {
    const roleId = 'role_extraction_crash';
    const repository = new BlockingAfterExperienceSaveRepository();
    const infrastructure = await createInfrastructure(roleId, repository);
    const firstService = await createService(infrastructure, createExtractor(), undefined, 5);

    const receipt = await firstService.enqueue({
      role_id: roleId,
      buffer_seq: 1,
      task_id: 'task_role_extraction_crash',
      run_id: 'run_extraction_crash',
    });
    await repository.firstSavePersisted;
    await firstService.close();

    const replayService = await createService(infrastructure, createExtractor());
    await replayService.start();
    await replayService.waitForIdle();

    const experiences = await infrastructure.memory.listExperiences();
    expect(experiences).toHaveLength(1);
    await expect(replayService.getJob(receipt.ref)).resolves.toMatchObject({ status: 'completed' });
  });

  it('repairs a crash between Skill save and Experience update without creating another Skill', async () => {
    const infrastructure = await createInfrastructure('role_skill_crash');
    const skillPersisted = deferred<void>();
    const neverFinishes = deferred<void>();
    const crashPromotion = async (
      memory: AgentMemoryScope,
      _task: unknown,
      experiences: ExperienceRecord[],
    ) => {
      const experience = experiences[0]!;
      const now = nowTimestamp();
      const skill: SkillRecord = {
        id: randomUUID(),
        description: experience.description,
        description_embedding: experience.description_embedding,
        content: experience.content,
        version: '1.0.0',
        review_status: 'pending',
        tags: [...experience.tags],
        promoted_from: experience.id,
        promoted_at: now,
        agent_id: memory.role_id,
        created_at: now,
        updated_at: now,
      };
      await memory.saveSkill(skill);
      skillPersisted.resolve();
      await neverFinishes.promise;
      throw new Error('unreachable');
    };
    const firstService = await createService(infrastructure, createExtractor(), crashPromotion, 5);

    const receipt = await firstService.enqueue({
      role_id: infrastructure.roleId,
      buffer_seq: 1,
      task_id: 'task_role_skill_crash',
      run_id: 'run_skill_crash',
    });
    await skillPersisted.promise;
    await firstService.close();

    const replayService = await createService(infrastructure, createExtractor());
    await replayService.start();
    await replayService.waitForIdle();

    const experiences = await infrastructure.memory.listExperiences();
    const skills = await infrastructure.memory.listSkills();
    expect(experiences).toHaveLength(1);
    expect(skills).toHaveLength(1);
    expect(experiences[0]!.promoted_to).toBe(skills[0]!.id);
    await expect(replayService.getJob(receipt.ref)).resolves.toMatchObject({ status: 'completed' });
  });

  it('reconciles persisted Skill ids after a crash before job completion', async () => {
    const infrastructure = await createInfrastructure('role_skill_completion_crash');
    const now = nowTimestamp();
    for (let index = 0; index < 4; index += 1) {
      await infrastructure.memory.saveExperience(
        createStoredExperience(
          infrastructure.roleId,
          `task_crash_historical_${String(index)}`,
          now,
          0.96,
        ),
      );
    }
    const promotionPersisted = deferred<void>();
    const neverFinishes = deferred<void>();
    const blockingPromotionProcessor = new (class extends SkillPromotionProcessor {
      override async executePromotionPlan(memory: AgentMemoryScope, plan: SkillPromotionPlan) {
        const outcomes = await super.executePromotionPlan(memory, plan);
        promotionPersisted.resolve();
        await neverFinishes.promise;
        return outcomes;
      }
    })(new DefaultPromotionTriggerPolicy(5, 0.98, 86_400_000), ruleBasedSkillPromotion);
    const firstService = new FileMemoryMaintenanceService({
      appStateRoot: infrastructure.appStateRoot,
      listRoleIds: () => infrastructure.repository.listAgentIds(),
      memoryForRole: (roleId) =>
        createAgentMemoryScope(infrastructure.repository, infrastructure.bufferRepository, roleId),
      experienceProcessor: new ExperienceExtractorProcessor(
        new AlwaysExtractPolicy(),
        createExtractor({ confidence: 0.96 }),
      ),
      skillPromotionProcessor: blockingPromotionProcessor,
      closeTimeoutMs: 5,
    });

    const receipt = await firstService.enqueue({
      role_id: infrastructure.roleId,
      buffer_seq: 1,
      task_id: 'task_role_skill_completion_crash',
      run_id: 'run_skill_completion_crash',
    });
    await promotionPersisted.promise;
    await expect(firstService.close()).resolves.toEqual({ drained: false });

    const replayService = await createService(
      infrastructure,
      createExtractor({ confidence: 0.96 }),
    );
    await replayService.start();
    await replayService.waitForIdle();

    const skills = await infrastructure.memory.listSkills();
    expect(skills).toHaveLength(5);
    await expect(replayService.getJob(receipt.ref)).resolves.toMatchObject({
      status: 'completed',
      promotion_plan: {
        experience_ids: expect.arrayContaining(skills.map((s) => s.promoted_from)),
      },
      result: { skill_count: 5, skill_ids: skills.map((skill) => skill.id).sort() },
    });
  });

  it('serializes jobs for one role and bounds idempotent close', async () => {
    const infrastructure = await createInfrastructure('role_serial');
    await writePendingBuffer(infrastructure.memory, 'task_serial_2');
    const releaseFirst = deferred<void>();
    const calls: string[] = [];
    const extractor = createExtractor({
      onExtract: (snapshot) => calls.push(snapshot.task_id),
      beforeReturn: (snapshot) =>
        snapshot.task_id === 'task_role_serial' ? releaseFirst.promise : Promise.resolve(),
    });
    const service = await createService(infrastructure, extractor, undefined, 5);

    await service.enqueue({
      role_id: infrastructure.roleId,
      buffer_seq: 1,
      task_id: 'task_role_serial',
      run_id: 'run_serial_1',
    });
    await service.enqueue({
      role_id: infrastructure.roleId,
      buffer_seq: 2,
      task_id: 'task_serial_2',
      run_id: 'run_serial_2',
    });
    await vi.waitFor(() => expect(calls).toEqual(['task_role_serial']));

    const startedAt = Date.now();
    const closeResults = await Promise.all([service.close(), service.close()]);
    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(closeResults).toEqual([{ drained: false }, { drained: false }]);
    expect(calls).toEqual(['task_role_serial']);

    releaseFirst.resolve();
    await service.waitForIdle();
    expect(calls).toEqual(['task_role_serial']);
    await expect(service.getJobForBuffer(infrastructure.roleId, 1)).resolves.toMatchObject({
      status: 'running',
    });
    await expect(service.getJobForBuffer(infrastructure.roleId, 2)).resolves.toMatchObject({
      status: 'pending',
    });
  });

  it('waits for a slow enqueue write before a replacement service can replay', async () => {
    const infrastructure = await createInfrastructure('role_slow_enqueue');
    const pendingReadStarted = deferred<void>();
    const releasePendingRead = deferred<void>();
    const slowMemory = new Proxy(infrastructure.memory, {
      get(target, property) {
        if (property === 'getPendingBuffer') {
          return async (seq: number) => {
            pendingReadStarted.resolve();
            await releasePendingRead.promise;
            return target.getPendingBuffer(seq);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const service = new FileMemoryMaintenanceService({
      appStateRoot: infrastructure.appStateRoot,
      listRoleIds: () => infrastructure.repository.listAgentIds(),
      memoryForRole: () => slowMemory,
      experienceProcessor: new ExperienceExtractorProcessor(
        new AlwaysExtractPolicy(),
        createExtractor(),
      ),
      skillPromotionProcessor: new SkillPromotionProcessor(
        new DefaultPromotionTriggerPolicy(5, 0.98, 86_400_000),
        ruleBasedSkillPromotion,
      ),
      closeTimeoutMs: 5,
    });

    const enqueue = service.enqueue({
      role_id: infrastructure.roleId,
      buffer_seq: 1,
      task_id: 'task_role_slow_enqueue',
      run_id: 'run_slow_enqueue',
    });
    await pendingReadStarted.promise;
    await expect(service.close()).resolves.toEqual({ drained: false });

    releasePendingRead.resolve();
    const receipt = await enqueue;
    await service.waitForIdle();
    await expect(service.getStatus(receipt.ref)).resolves.toMatchObject({ status: 'pending' });

    const replacement = await createService(infrastructure, createExtractor());
    await replacement.start();
    await replacement.waitForIdle();
    await expect(replacement.getStatus(receipt.ref)).resolves.toMatchObject({
      status: 'completed',
    });
  });

  it('leaves background failures observable after close drains the worker', async () => {
    const infrastructure = await createInfrastructure('role_close_error');
    let memoryLookups = 0;
    const service = new FileMemoryMaintenanceService({
      appStateRoot: infrastructure.appStateRoot,
      listRoleIds: async () => [],
      memoryForRole: () => {
        memoryLookups += 1;
        if (memoryLookups > 1) throw new Error('maintenance worker failed');
        return infrastructure.memory;
      },
      experienceProcessor: new ExperienceExtractorProcessor(
        new AlwaysExtractPolicy(),
        createExtractor(),
      ),
      skillPromotionProcessor: new SkillPromotionProcessor(
        new DefaultPromotionTriggerPolicy(5, 0.98, 86_400_000),
        ruleBasedSkillPromotion,
      ),
    });

    await service.start();
    await service.enqueue({
      role_id: infrastructure.roleId,
      buffer_seq: 1,
      task_id: 'task_role_close_error',
      run_id: 'run_close_error',
    });

    await expect(service.close()).resolves.toEqual({ drained: true });
    await expect(service.waitForIdle()).rejects.toMatchObject({
      message: 'Memory maintenance background processing failed',
      errors: [expect.objectContaining({ message: 'maintenance worker failed' })],
    });
  });

  it('allows different roles to run concurrently', async () => {
    const appStateRoot = await mkdtemp(join(tmpdir(), 'newide-memory-maintenance-'));
    roots.push(appStateRoot);
    const repository = new InMemoryRepository();
    const bufferRepository = new InMemoryBufferRepository();
    const roleIds = ['role_concurrent_a', 'role_concurrent_b'];
    for (const roleId of roleIds) {
      await repository.initializeAgent({ role_id: roleId, name: roleId, tags: [] });
      await bufferRepository.ensureAgent(roleId);
      await writePendingBuffer(
        createAgentMemoryScope(repository, bufferRepository, roleId),
        `task_${roleId}`,
      );
    }
    const bothStarted = deferred<void>();
    const release = deferred<void>();
    const started = new Set<string>();
    const extractor = createExtractor({
      onExtract(snapshot) {
        started.add(snapshot.task_id);
        if (started.size === 2) bothStarted.resolve();
      },
      beforeReturn: () => release.promise,
    });
    const service = new FileMemoryMaintenanceService({
      appStateRoot,
      listRoleIds: () => repository.listAgentIds(),
      memoryForRole: (roleId) => createAgentMemoryScope(repository, bufferRepository, roleId),
      experienceProcessor: new ExperienceExtractorProcessor(new AlwaysExtractPolicy(), extractor),
      skillPromotionProcessor: new SkillPromotionProcessor(
        new DefaultPromotionTriggerPolicy(10, 0.98, 86_400_000),
        ruleBasedSkillPromotion,
      ),
    });

    await service.start();
    await bothStarted.promise;
    expect([...started].sort()).toEqual(['task_role_concurrent_a', 'task_role_concurrent_b']);

    release.resolve();
    await service.waitForIdle();
  });
});

async function createInfrastructure(
  roleId: string,
  repository: InMemoryRepository = new InMemoryRepository(),
) {
  const appStateRoot = await mkdtemp(join(tmpdir(), 'newide-memory-maintenance-'));
  roots.push(appStateRoot);
  const bufferRepository = new InMemoryBufferRepository();
  await repository.initializeAgent({ role_id: roleId, name: roleId, tags: [] });
  await bufferRepository.ensureAgent(roleId);
  const memory = createAgentMemoryScope(repository, bufferRepository, roleId);
  await writePendingBuffer(memory, `task_${roleId}`);
  return { appStateRoot, repository, bufferRepository, memory, roleId };
}

async function createService(
  infrastructure: Awaited<ReturnType<typeof createInfrastructure>>,
  extractor: ExperienceExtractor,
  promote = ruleBasedSkillPromotion,
  closeTimeoutMs = 100,
) {
  return new FileMemoryMaintenanceService({
    appStateRoot: infrastructure.appStateRoot,
    memoryForRole: (roleId) =>
      createAgentMemoryScope(infrastructure.repository, infrastructure.bufferRepository, roleId),
    listRoleIds: () => infrastructure.repository.listAgentIds(),
    experienceProcessor: new ExperienceExtractorProcessor(new AlwaysExtractPolicy(), extractor),
    skillPromotionProcessor: new SkillPromotionProcessor(
      new DefaultPromotionTriggerPolicy(5, 0.98, 86_400_000),
      promote,
    ),
    closeTimeoutMs,
  });
}

function createExtractor(
  options: {
    agentId?: string;
    confidence?: number;
    onExtract?: (snapshot: BufferSnapshot) => void;
    beforeReturn?: (snapshot: BufferSnapshot) => Promise<void>;
  } = {},
): ExperienceExtractor {
  return {
    async extract(snapshot): Promise<ExtractionOutput> {
      options.onExtract?.(snapshot);
      await options.beforeReturn?.(snapshot);
      const now = nowTimestamp();
      const confidence = options.confidence ?? 0.99;
      return {
        experiences: [
          {
            id: randomUUID(),
            description: `Experience for ${snapshot.task_id}`,
            description_embedding: [0.1, 0.2, 0.3],
            content: `Reusable result from ${snapshot.task_id}`,
            confidence,
            tags: ['test'],
            agent_id: options.agentId ?? snapshot.source_task_id,
            type: 'positive',
            confidence_history: [{ value: confidence, updated_at: now, reason: 'fixture' }],
            referenced_count: 0,
            source_task_id: snapshot.source_task_id,
            source_driver: snapshot.source_driver,
            created_at: now,
            updated_at: now,
          },
        ],
        result: {
          experiences_created: 1,
          experiences_updated: 0,
          negative_experiences: 0,
          skills_promoted: 0,
        },
      };
    },
  };
}

function createStoredExperience(
  roleId: string,
  sourceTaskId: string,
  timestamp: string,
  confidence: number,
): ExperienceRecord {
  return {
    id: randomUUID(),
    description: `Historical experience ${sourceTaskId}`,
    description_embedding: [0.1, 0.2, 0.3],
    content: `Reusable result from ${sourceTaskId}`,
    confidence,
    tags: ['historical'],
    agent_id: roleId,
    type: 'positive',
    confidence_history: [{ value: confidence, updated_at: timestamp, reason: 'fixture' }],
    referenced_count: 0,
    source_task_id: sourceTaskId,
    source_driver: 'test-driver',
    created_at: timestamp,
    updated_at: timestamp,
  };
}

async function writePendingBuffer(memory: AgentMemoryScope, taskId: string): Promise<number> {
  const snapshot: BufferSnapshot = {
    task_id: taskId,
    task_description: `Task ${taskId}`,
    driver_return: {
      artifacts: [],
      summary: `Completed ${taskId}`,
      decisions: [],
      blockers: [],
      referenced_experiences: [],
      assumptions: [],
      effectiveness: 'fully_effective',
    },
    source_task_id: taskId,
    source_driver: 'test-driver',
    received_at: nowTimestamp(),
    retry_count: 0,
    extraction_status: 'pending',
  };
  return (await memory.saveBufferSnapshot(snapshot)).seq;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class BlockingAfterExperienceSaveRepository extends InMemoryRepository {
  private readonly persisted = deferred<void>();
  private readonly neverFinishes = deferred<void>();
  readonly firstSavePersisted = this.persisted.promise;

  override async saveExperience(
    ...args: Parameters<InMemoryRepository['saveExperience']>
  ): ReturnType<InMemoryRepository['saveExperience']> {
    await super.saveExperience(...args);
    this.persisted.resolve();
    await this.neverFinishes.promise;
  }
}
