import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nowTimestamp } from '../../core';
import { HashEmbeddingProvider } from '../adapters/hash-embedding-provider';
import { SqliteMemoryRepository } from '../adapters/sqlite-memory-repository';
import { configureSqliteMemoryDatabase } from '../adapters/sqlite-memory-schema';
import { AgentHandleSchema, ExperienceRecordSchema, SkillRecordSchema } from '../schemas';
import type { ExperienceRecord, SkillRecord } from '../schemas';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('SqliteMemoryRepository', () => {
  it('creates a WAL database and round-trips records across restart', async () => {
    const databasePath = createDatabasePath();
    const repository = new SqliteMemoryRepository({ databasePath });
    const roleId = 'role_sqlite_roundtrip';

    await repository.initializeAgent({
      role_id: roleId,
      name: 'SQLite Agent',
      tags: ['typescript'],
      persona_seed: 'Persistent backend specialist',
    });
    await repository.saveSkill(roleId, createSkill(roleId, { description_embedding: [] }));
    await repository.saveExperience(
      roleId,
      createExperience(roleId, { description_embedding: [] }),
    );
    repository.close();
    repository.close();

    const restarted = new SqliteMemoryRepository({ databasePath });
    const handle = AgentHandleSchema.parse(await restarted.getAgent(roleId));
    const skills = SkillRecordSchema.array().parse(await restarted.listSkills(roleId));
    const experiences = ExperienceRecordSchema.array().parse(
      await restarted.listExperiences(roleId),
    );

    expect(handle.name).toBe('SQLite Agent');
    expect(handle.persona.summary).toBe('Persistent backend specialist');
    expect(handle.skill_count).toBe(1);
    expect(handle.experience_count).toBe(1);
    expect(handle.metric.skill_count).toBe(1);
    expect(handle.metric.experience_count).toBe(1);
    expect(skills[0]?.description_embedding).toHaveLength(32);
    expect(experiences[0]?.description_embedding).toHaveLength(32);
    restarted.close();

    const database = new DatabaseSync(databasePath);
    configureSqliteMemoryDatabase(database);
    expect(readPragmaString(database, 'journal_mode')).toBe('wal');
    expect(readPragmaNumber(database, 'foreign_keys')).toBe(1);
    expect(readPragmaNumber(database, 'busy_timeout')).toBe(5_000);
    database.close();
  });

  it('filters ineligible records and returns stable top-K vector matches', async () => {
    const embedding = new HashEmbeddingProvider();
    const repository = new SqliteMemoryRepository({
      databasePath: createDatabasePath(),
      embedding,
    });
    const roleId = 'role_sqlite_search';
    await repository.initializeAgent({ role_id: roleId, name: roleId });
    const queryEmbedding = await embedding.embed('typescript contract boundaries');
    const lowerSkillId = '00000000-0000-4000-8000-000000000010';
    const higherSkillId = '00000000-0000-4000-8000-000000000020';
    const lowerExperienceId = '00000000-0000-4000-8000-000000000030';
    const higherExperienceId = '00000000-0000-4000-8000-000000000040';

    for (const id of [higherSkillId, lowerSkillId]) {
      await repository.saveSkill(
        roleId,
        createSkill(roleId, { id, description_embedding: queryEmbedding }),
      );
    }
    await repository.saveSkill(
      roleId,
      createSkill(roleId, {
        review_status: 'pending',
        description_embedding: queryEmbedding,
      }),
    );
    await repository.saveSkill(
      roleId,
      createSkill(roleId, {
        market_status: 'superseded',
        description_embedding: queryEmbedding,
      }),
    );
    for (const id of [higherExperienceId, lowerExperienceId]) {
      await repository.saveExperience(
        roleId,
        createExperience(roleId, { id, description_embedding: queryEmbedding }),
      );
    }
    await repository.saveExperience(
      roleId,
      createExperience(roleId, { confidence: 0.1, description_embedding: queryEmbedding }),
    );
    await repository.saveExperience(
      roleId,
      createExperience(roleId, { type: 'negative', description_embedding: queryEmbedding }),
    );
    await repository.saveExperience(
      roleId,
      createExperience(roleId, {
        promoted_to: randomUUID(),
        description_embedding: queryEmbedding,
      }),
    );

    await expect(
      repository.searchSkills(roleId, { query_embedding: queryEmbedding, top_k: 1 }),
    ).resolves.toMatchObject([{ id: lowerSkillId }]);
    await expect(
      repository.searchExperiences(roleId, {
        query_embedding: queryEmbedding,
        top_k: 1,
        min_confidence: 0.2,
      }),
    ).resolves.toMatchObject([{ id: lowerExperienceId }]);
    repository.close();
  });

  it('applies similarity thresholds before top-K truncation', async () => {
    const embedding = new HashEmbeddingProvider();
    const repository = new SqliteMemoryRepository({
      databasePath: createDatabasePath(),
      embedding,
    });
    const roleId = 'role_sqlite_threshold';
    await repository.initializeAgent({ role_id: roleId, name: roleId });
    await repository.saveSkill(
      roleId,
      createSkill(roleId, {
        description: 'Alpine skiing equipment',
        description_embedding: await embedding.embed('Alpine skiing equipment'),
      }),
    );

    const matches = await repository.searchSkills(roleId, {
      query_embedding: await embedding.embed('typescript contract boundaries'),
      top_k: 10,
      min_similarity: 0.99,
    });

    expect(matches).toEqual([]);
    repository.close();
  });

  it('updates an existing experience and rejects a missing one', async () => {
    const repository = new SqliteMemoryRepository({ databasePath: createDatabasePath() });
    const roleId = 'role_sqlite_update';
    await repository.initializeAgent({ role_id: roleId, name: roleId });
    const experience = createExperience(roleId);
    await repository.saveExperience(roleId, experience);

    await repository.updateExperience(roleId, {
      ...experience,
      content: 'updated experience body',
      description_embedding: [],
    });

    await expect(repository.listExperiences(roleId)).resolves.toMatchObject([
      { id: experience.id, content: 'updated experience body' },
    ]);
    await expect(repository.updateExperience(roleId, createExperience(roleId))).rejects.toThrow(
      'Experience not found',
    );
    repository.close();
  });

  it('rolls back duplicate skill and experience IDs without drifting aggregate counts', async () => {
    const repository = new SqliteMemoryRepository({ databasePath: createDatabasePath() });
    const roleId = 'role_sqlite_duplicate';
    await repository.initializeAgent({ role_id: roleId, name: roleId });
    const experience = createExperience(roleId);
    const skill = createSkill(roleId);
    await repository.saveExperience(roleId, experience);
    await repository.saveSkill(roleId, skill);

    await expect(repository.saveExperience(roleId, experience)).rejects.toThrow(
      `Experience already exists: ${experience.id}`,
    );
    await expect(repository.saveSkill(roleId, skill)).rejects.toThrow(
      `Skill already exists: ${skill.id}`,
    );

    const handle = await repository.getAgent(roleId);
    const metrics = await repository.getMetrics(roleId);
    expect(handle.experience_count).toBe(1);
    expect(handle.owned_exps).toEqual([experience.id]);
    expect(handle.skill_count).toBe(1);
    expect(handle.owned_skills).toEqual([skill.id]);
    expect(metrics.experience_count).toBe(1);
    expect(metrics.skill_count).toBe(1);
    repository.close();
  });

  it('serializes writes from two repository instances without losing records or counts', async () => {
    const databasePath = createDatabasePath();
    const first = new SqliteMemoryRepository({ databasePath });
    const second = new SqliteMemoryRepository({ databasePath });
    const roleId = 'role_sqlite_concurrent';
    await first.initializeAgent({ role_id: roleId, name: roleId });
    const experiences = [createExperience(roleId), createExperience(roleId)];

    await Promise.all([
      first.saveExperience(roleId, experiences[0]!),
      second.saveExperience(roleId, experiences[1]!),
    ]);

    expect(await first.listExperiences(roleId)).toHaveLength(2);
    expect((await second.getAgent(roleId)).experience_count).toBe(2);
    expect((await second.getMetrics(roleId)).experience_count).toBe(2);
    first.close();
    second.close();
  });

  it('allows multiple processes to initialize the same fresh database concurrently', async () => {
    for (let round = 0; round < 5; round += 1) {
      const databasePath = createDatabasePath();
      const barrierRoot = path.join(path.dirname(databasePath), 'barrier');
      const releasePath = path.join(barrierRoot, 'release');
      mkdirSync(barrierRoot, { recursive: true });
      const completions = Array.from({ length: 12 }, (_, index) =>
        initializeRepositoryInChild(
          databasePath,
          `role_child_${String(round)}_${String(index)}`,
          path.join(barrierRoot, `ready-${String(index)}`),
          releasePath,
        ),
      );
      await waitUntil(
        () => readdirSync(barrierRoot).filter((name) => name.startsWith('ready-')).length,
      );
      writeFileSync(releasePath, 'release', 'utf8');
      const results = await Promise.allSettled(completions);
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [String(result.reason)] : [],
      );
      if (failures.length > 0) {
        throw new Error(
          `Concurrent SQLite initialization failed in round ${String(round)}:\n${failures.join('\n')}`,
        );
      }

      const repository = new SqliteMemoryRepository({ databasePath });
      await expect(repository.listAgentIds()).resolves.toHaveLength(12);
      repository.close();
    }
  }, 60_000);

  it('rolls back the inserted record when an aggregate update fails', async () => {
    const databasePath = createDatabasePath();
    const repository = new SqliteMemoryRepository({ databasePath });
    const roleId = 'role_sqlite_rollback';
    await repository.initializeAgent({ role_id: roleId, name: roleId });
    const external = new DatabaseSync(databasePath);
    external.exec(`
      CREATE TRIGGER force_memory_agent_update_failure
      BEFORE UPDATE ON memory_agents
      BEGIN
        SELECT RAISE(ABORT, 'forced aggregate failure');
      END;
    `);

    await expect(repository.saveExperience(roleId, createExperience(roleId))).rejects.toThrow(
      'forced aggregate failure',
    );
    expect(await repository.listExperiences(roleId)).toEqual([]);
    expect((await repository.getAgent(roleId)).experience_count).toBe(0);

    external.exec('DROP TRIGGER force_memory_agent_update_failure');
    external.close();
    await repository.saveExperience(roleId, createExperience(roleId));
    expect(await repository.listExperiences(roleId)).toHaveLength(1);
    repository.close();
  });

  it('rejects databases created by a future schema version', () => {
    const databasePath = createDatabasePath();
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE memory_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      INSERT INTO memory_schema_migrations(version, applied_at)
      VALUES (999, '2099-01-01T00:00:00.000Z');
    `);
    database.close();

    expect(() => new SqliteMemoryRepository({ databasePath })).toThrow(
      'Unsupported SQLite memory schema version: 999',
    );
  });

  it('rejects an embedding dimension change on an existing database', () => {
    const databasePath = createDatabasePath();
    const repository = new SqliteMemoryRepository({ databasePath });
    repository.close();

    expect(
      () =>
        new SqliteMemoryRepository({
          databasePath,
          embedding: new HashEmbeddingProvider(64),
        }),
    ).toThrow('SQLite memory embedding dimensions mismatch: stored 32, configured 64');
  });

  it('closes idempotently and rejects further access', async () => {
    const repository = new SqliteMemoryRepository({ databasePath: createDatabasePath() });
    repository.close();
    repository.close();

    await expect(repository.listAgentIds()).rejects.toThrow('SQLite memory repository is closed');
  });
});

function createDatabasePath(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'newide-sqlite-memory-'));
  temporaryRoots.push(root);
  const directory = path.join(root, 'b');
  mkdirSync(directory, { recursive: true });
  return path.join(directory, 'memory.sqlite');
}

function initializeRepositoryInChild(
  databasePath: string,
  roleId: string,
  readyPath: string,
  releasePath: string,
): Promise<void> {
  const repositoryModule = new URL('../adapters/sqlite-memory-repository.ts', import.meta.url).href;
  const source = `
    import { existsSync, writeFileSync } from 'node:fs';
    import { SqliteMemoryRepository } from ${JSON.stringify(repositoryModule)};
    writeFileSync(${JSON.stringify(readyPath)}, 'ready', 'utf8');
    while (!existsSync(${JSON.stringify(releasePath)})) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const repository = new SqliteMemoryRepository({ databasePath: ${JSON.stringify(databasePath)} });
    await repository.ensureAgent(${JSON.stringify(roleId)});
    repository.close();
  `;

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', source],
      {
        cwd: process.cwd(),
        env: { ...process.env, NODE_NO_WARNINGS: '1' },
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `child exited code=${String(code)} signal=${String(signal)} stderr=${stderr.trim()}`,
        ),
      );
    });
  });
}

async function waitUntil(readReadyCount: () => number): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (readReadyCount() < 12) {
    if (Date.now() >= deadline)
      throw new Error('Timed out waiting for SQLite initializer children');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function createExperience(
  roleId: string,
  overrides: Partial<ExperienceRecord> = {},
): ExperienceRecord {
  const now = nowTimestamp();
  return ExperienceRecordSchema.parse({
    id: randomUUID(),
    description: 'Handle TypeScript contract boundaries.',
    description_embedding: [],
    content: 'full experience content body',
    confidence: 0.8,
    tags: ['typescript', 'contracts'],
    agent_id: roleId,
    confidence_history: [{ value: 0.8, updated_at: now, reason: 'seed' }],
    referenced_count: 1,
    source_task_id: 'task_seed',
    source_driver: 'test-driver',
    type: 'positive',
    created_at: now,
    updated_at: now,
    ...overrides,
  });
}

function createSkill(roleId: string, overrides: Partial<SkillRecord> = {}): SkillRecord {
  const now = nowTimestamp();
  return SkillRecordSchema.parse({
    id: randomUUID(),
    description: 'Write stable TypeScript interfaces.',
    description_embedding: [],
    content: 'full skill content body',
    version: '1.0.0',
    review_status: 'approved',
    tags: ['typescript'],
    promoted_at: now,
    agent_id: roleId,
    created_at: now,
    updated_at: now,
    ...overrides,
  });
}

function readPragmaString(database: DatabaseSync, name: string): string {
  const row = database.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>;
  return String(Object.values(row)[0]);
}

function readPragmaNumber(database: DatabaseSync, name: string): number {
  return Number(readPragmaString(database, name));
}
