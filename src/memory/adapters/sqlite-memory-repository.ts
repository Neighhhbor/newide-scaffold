import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  AgentHandleSchema,
  AgentMetricsSchema,
  CreateAgentSpecSchema,
  ExperienceRecordSchema,
  PersonaDefSchema,
  SkillRecordSchema,
  type AgentHandle,
  type AgentMetrics,
  type CreateAgentSpec,
  type ExperienceRecord,
  type PersonaDef,
  type SkillRecord,
} from '../schemas';
import type { EmbeddingProvider } from '../ports/embedding-provider';
import type { MemoryRepository, MemoryVectorSearchOptions } from '../ports/memory-repository';
import { defaultHashEmbeddingProvider } from './hash-embedding-provider';
import {
  createSeedHandle,
  createSeedMetrics,
  createSeedPersona,
  DEFAULT_MIN_EXPERIENCE_CONFIDENCE,
  DEFAULT_MIN_SIMILARITY,
  isEligibleExperience,
  isEligibleSkill,
} from './memory-repository-seeds';
import {
  configureSqliteMemoryDatabase,
  ensureSqliteMemorySchema,
  SQLITE_MEMORY_BUSY_TIMEOUT_MS,
} from './sqlite-memory-schema';

const INITIALIZATION_DEADLINE_MS = 5_000;
const INITIALIZATION_ATTEMPT_TIMEOUT_MS = 250;
const INITIALIZATION_BACKOFF_MIN_MS = 10;
const INITIALIZATION_BACKOFF_MAX_MS = 200;
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const SLEEP_ARRAY = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

export interface SqliteMemoryRepositoryOptions {
  databasePath: string;
  embedding?: EmbeddingProvider;
}

interface AgentRow {
  handle_json: string;
  persona_json: string;
  metrics_json: string;
}

interface PayloadRow {
  payload_json: string;
}

interface ScoredRecord<T> {
  item: T;
  similarity: number;
}

export class SqliteMemoryRepository implements MemoryRepository {
  private readonly database: DatabaseSync;
  private readonly embedding: EmbeddingProvider;
  private closed = false;

  constructor(options: SqliteMemoryRepositoryOptions) {
    if (options.databasePath !== ':memory:') {
      mkdirSync(path.dirname(options.databasePath), { recursive: true });
    }
    this.embedding = options.embedding ?? defaultHashEmbeddingProvider;
    this.database = openInitializedDatabase(options.databasePath, this.embedding.dimensions);
  }

  async ensureAgent(role_id: string): Promise<void> {
    this.requireOpen();
    this.transaction(() => {
      if (this.findAgentRow(role_id)) return;
      this.insertAgent({ role_id, name: role_id });
    });
  }

  async initializeAgent(spec: CreateAgentSpec): Promise<void> {
    this.requireOpen();
    const parsed = CreateAgentSpecSchema.parse(spec);
    this.transaction(() => {
      if (this.findAgentRow(parsed.role_id)) {
        throw new Error(`Agent already exists: ${parsed.role_id}`);
      }
      this.insertAgent(parsed);
    });
  }

  async listAgentIds(): Promise<string[]> {
    this.requireOpen();
    return this.database
      .prepare('SELECT role_id FROM memory_agents ORDER BY role_id COLLATE BINARY')
      .all()
      .map((row) => readString(row as Record<string, unknown>, 'role_id'));
  }

  async getAgent(role_id: string): Promise<AgentHandle> {
    this.requireOpen();
    return AgentHandleSchema.parse(JSON.parse(this.requireAgentRow(role_id).handle_json));
  }

  async getPersona(role_id: string): Promise<PersonaDef> {
    this.requireOpen();
    return PersonaDefSchema.parse(JSON.parse(this.requireAgentRow(role_id).persona_json));
  }

  async getMetrics(role_id: string): Promise<AgentMetrics> {
    this.requireOpen();
    return AgentMetricsSchema.parse(JSON.parse(this.requireAgentRow(role_id).metrics_json));
  }

  async listSkills(role_id: string): Promise<SkillRecord[]> {
    this.requireOpen();
    this.requireAgentRow(role_id);
    return this.listPayloads(
      `SELECT payload_json FROM memory_skills
       WHERE role_id = ? ORDER BY created_at ASC, id COLLATE BINARY ASC`,
      role_id,
      SkillRecordSchema.parse,
    );
  }

  async listExperiences(role_id: string): Promise<ExperienceRecord[]> {
    this.requireOpen();
    this.requireAgentRow(role_id);
    return this.listPayloads(
      `SELECT payload_json FROM memory_experiences
       WHERE role_id = ? ORDER BY created_at ASC, id COLLATE BINARY ASC`,
      role_id,
      ExperienceRecordSchema.parse,
    );
  }

  async searchSkills(role_id: string, options: MemoryVectorSearchOptions): Promise<SkillRecord[]> {
    const eligible = (await this.listSkills(role_id)).filter(isEligibleSkill);
    return rankByVectorSimilarity(eligible, options, this.embedding);
  }

  async searchExperiences(
    role_id: string,
    options: MemoryVectorSearchOptions,
  ): Promise<ExperienceRecord[]> {
    const minConfidence = options.min_confidence ?? DEFAULT_MIN_EXPERIENCE_CONFIDENCE;
    const eligible = (await this.listExperiences(role_id)).filter((experience) =>
      isEligibleExperience(experience, minConfidence),
    );
    return rankByVectorSimilarity(eligible, options, this.embedding);
  }

  async saveExperience(role_id: string, experience: ExperienceRecord): Promise<void> {
    this.requireOpen();
    const stored = ExperienceRecordSchema.parse(await this.withDescriptionEmbedding(experience));
    this.requireOpen();
    this.transaction(() => {
      this.requireAgentRow(role_id);
      if (this.recordExists('memory_experiences', stored.id)) {
        throw new Error(`Experience already exists: ${stored.id}`);
      }
      this.database
        .prepare(
          `INSERT INTO memory_experiences(id, role_id, payload_json, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(stored.id, role_id, JSON.stringify(stored), stored.created_at);
      this.refreshAgentAggregates(role_id);
    });
  }

  async saveSkill(role_id: string, skill: SkillRecord): Promise<void> {
    this.requireOpen();
    const stored = SkillRecordSchema.parse(await this.withDescriptionEmbedding(skill));
    this.requireOpen();
    this.transaction(() => {
      this.requireAgentRow(role_id);
      if (this.recordExists('memory_skills', stored.id)) {
        throw new Error(`Skill already exists: ${stored.id}`);
      }
      this.database
        .prepare(
          `INSERT INTO memory_skills(id, role_id, payload_json, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(stored.id, role_id, JSON.stringify(stored), stored.created_at);
      this.refreshAgentAggregates(role_id);
    });
  }

  async updateExperience(role_id: string, experience: ExperienceRecord): Promise<void> {
    this.requireOpen();
    const stored = ExperienceRecordSchema.parse(await this.withDescriptionEmbedding(experience));
    this.requireOpen();
    this.transaction(() => {
      this.requireAgentRow(role_id);
      const result = this.database
        .prepare(
          `UPDATE memory_experiences
           SET payload_json = ?, created_at = ?
           WHERE role_id = ? AND id = ?`,
        )
        .run(JSON.stringify(stored), stored.created_at, role_id, stored.id);
      if (result.changes === 0) throw new Error(`Experience not found: ${stored.id}`);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private insertAgent(spec: CreateAgentSpec): void {
    const persona = PersonaDefSchema.parse(createSeedPersona(spec.role_id, spec.persona_seed));
    const metrics = AgentMetricsSchema.parse(createSeedMetrics(spec.role_id));
    const handle = AgentHandleSchema.parse(createSeedHandle(spec, persona, metrics));
    this.database
      .prepare(
        `INSERT INTO memory_agents(role_id, handle_json, persona_json, metrics_json)
         VALUES (?, ?, ?, ?)`,
      )
      .run(spec.role_id, JSON.stringify(handle), JSON.stringify(persona), JSON.stringify(metrics));
  }

  private refreshAgentAggregates(role_id: string): void {
    const row = this.requireAgentRow(role_id);
    const handle = AgentHandleSchema.parse(JSON.parse(row.handle_json));
    const persona = PersonaDefSchema.parse(JSON.parse(row.persona_json));
    const metrics = AgentMetricsSchema.parse(JSON.parse(row.metrics_json));
    const skillIds = this.listRecordIds('memory_skills', role_id);
    const experienceIds = this.listRecordIds('memory_experiences', role_id);
    const updatedMetrics = AgentMetricsSchema.parse({
      ...metrics,
      skill_count: skillIds.length,
      experience_count: experienceIds.length,
      promoted_skill_count: skillIds.length,
    });
    const updatedHandle = AgentHandleSchema.parse({
      ...handle,
      persona,
      skill_count: skillIds.length,
      experience_count: experienceIds.length,
      owned_skills: skillIds,
      owned_exps: experienceIds,
      metric: updatedMetrics,
    });
    this.database
      .prepare('UPDATE memory_agents SET handle_json = ?, metrics_json = ? WHERE role_id = ?')
      .run(JSON.stringify(updatedHandle), JSON.stringify(updatedMetrics), role_id);
  }

  private listRecordIds(table: 'memory_skills' | 'memory_experiences', role_id: string): string[] {
    return this.database
      .prepare(
        `SELECT id FROM ${table} WHERE role_id = ? ORDER BY created_at ASC, id COLLATE BINARY ASC`,
      )
      .all(role_id)
      .map((row) => readString(row as Record<string, unknown>, 'id'));
  }

  private listPayloads<T>(sql: string, role_id: string, parse: (value: unknown) => T): T[] {
    return this.database
      .prepare(sql)
      .all(role_id)
      .map((row) => parse(JSON.parse((row as unknown as PayloadRow).payload_json)));
  }

  private recordExists(table: 'memory_skills' | 'memory_experiences', id: string): boolean {
    return this.database.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(id) !== undefined;
  }

  private findAgentRow(role_id: string): AgentRow | undefined {
    return this.database
      .prepare(
        'SELECT handle_json, persona_json, metrics_json FROM memory_agents WHERE role_id = ?',
      )
      .get(role_id) as unknown as AgentRow | undefined;
  }

  private requireAgentRow(role_id: string): AgentRow {
    const row = this.findAgentRow(role_id);
    if (!row) throw new Error(`Agent not found: ${role_id}`);
    return row;
  }

  private async withDescriptionEmbedding<T extends SkillRecord | ExperienceRecord>(
    record: T,
  ): Promise<T> {
    if (record.description_embedding.length === this.embedding.dimensions) return record;
    return {
      ...record,
      description_embedding: await this.embedding.embed(record.description),
    };
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private requireOpen(): void {
    if (this.closed) throw new Error('SQLite memory repository is closed');
  }
}

async function rankByVectorSimilarity<T extends SkillRecord | ExperienceRecord>(
  items: T[],
  options: MemoryVectorSearchOptions,
  embedding: EmbeddingProvider,
): Promise<T[]> {
  const scored: ScoredRecord<T>[] = [];
  for (const item of items) {
    const itemEmbedding =
      item.description_embedding.length === embedding.dimensions
        ? item.description_embedding
        : await embedding.embed(item.description);
    scored.push({
      item,
      similarity: embedding.cosineSimilarity(options.query_embedding, itemEmbedding),
    });
  }
  return scored
    .filter((entry) => entry.similarity >= (options.min_similarity ?? DEFAULT_MIN_SIMILARITY))
    .sort((left, right) => {
      const bySimilarity = right.similarity - left.similarity;
      return bySimilarity || compareCodeUnits(left.item.id, right.item.id);
    })
    .slice(0, Math.max(0, options.top_k))
    .map((entry) => entry.item);
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function readString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new Error(`Expected ${key} to be a string`);
  return value;
}

function openInitializedDatabase(databasePath: string, dimensions: number): DatabaseSync {
  const deadline = Date.now() + INITIALIZATION_DEADLINE_MS;
  let attempt = 0;
  let lastLockError: unknown;

  while (true) {
    const remainingBeforeAttempt = deadline - Date.now();
    if (remainingBeforeAttempt <= 0) {
      throw initializationTimeout(lastLockError);
    }

    const database = new DatabaseSync(databasePath);
    try {
      configureSqliteMemoryDatabase(
        database,
        Math.min(INITIALIZATION_ATTEMPT_TIMEOUT_MS, remainingBeforeAttempt),
      );
      const remainingBeforeMigration = deadline - Date.now();
      if (remainingBeforeMigration <= 0) throw initializationTimeout(lastLockError);
      database.exec(
        `PRAGMA busy_timeout = ${String(
          Math.min(INITIALIZATION_ATTEMPT_TIMEOUT_MS, remainingBeforeMigration),
        )}`,
      );
      ensureSqliteMemorySchema(database, dimensions);
      database.exec(`PRAGMA busy_timeout = ${String(SQLITE_MEMORY_BUSY_TIMEOUT_MS)}`);
      return database;
    } catch (error) {
      try {
        database.close();
      } catch {
        // Preserve the initialization error; the connection is already unusable.
      }
      if (!isSqliteLockError(error)) throw error;
      lastLockError = error;
    }

    const remainingAfterAttempt = deadline - Date.now();
    if (remainingAfterAttempt <= 0) throw initializationTimeout(lastLockError);
    const backoff = Math.min(
      INITIALIZATION_BACKOFF_MIN_MS * 2 ** attempt,
      INITIALIZATION_BACKOFF_MAX_MS,
      remainingAfterAttempt,
    );
    sleepWithoutBusySpin(backoff);
    attempt += 1;
  }
}

function isSqliteLockError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const errorCode = Reflect.get(error, 'errcode');
  if (typeof errorCode !== 'number') return false;
  const primaryErrorCode = errorCode & 0xff;
  return primaryErrorCode === SQLITE_BUSY || primaryErrorCode === SQLITE_LOCKED;
}

function initializationTimeout(cause: unknown): Error {
  return new Error(
    `SQLite memory initialization timed out after ${String(INITIALIZATION_DEADLINE_MS)}ms because the database remained locked`,
    { cause },
  );
}

function sleepWithoutBusySpin(milliseconds: number): void {
  if (milliseconds <= 0) return;
  Atomics.wait(SLEEP_ARRAY, 0, 0, milliseconds);
}
