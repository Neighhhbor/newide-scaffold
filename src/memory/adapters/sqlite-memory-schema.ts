import type { DatabaseSync } from 'node:sqlite';

export const SQLITE_MEMORY_SCHEMA_VERSION = 1;
export const SQLITE_MEMORY_BUSY_TIMEOUT_MS = 5_000;

export function configureSqliteMemoryDatabase(
  database: DatabaseSync,
  busyTimeoutMs = SQLITE_MEMORY_BUSY_TIMEOUT_MS,
): void {
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    throw new Error(`Invalid SQLite memory busy timeout: ${String(busyTimeoutMs)}`);
  }
  database.exec(`
    PRAGMA busy_timeout = ${String(busyTimeoutMs)};
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
  `);
}

export function ensureSqliteMemorySchema(database: DatabaseSync, dimensions: number): void {
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error(`Invalid embedding dimensions: ${String(dimensions)}`);
  }

  let transactionStarted = false;
  try {
    database.exec('BEGIN IMMEDIATE');
    transactionStarted = true;
    database.exec(`
      CREATE TABLE IF NOT EXISTS memory_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    const currentVersion = readCurrentVersion(database);
    if (currentVersion > SQLITE_MEMORY_SCHEMA_VERSION) {
      throw new Error(`Unsupported SQLite memory schema version: ${String(currentVersion)}`);
    }

    if (currentVersion < 1) migrateToVersionOne(database);
    ensureEmbeddingDimensions(database, dimensions);
    database.exec('COMMIT');
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) {
      try {
        database.exec('ROLLBACK');
      } catch {
        // The failed SQLite statement may already have ended the transaction.
      }
    }
    throw error;
  }
}

function migrateToVersionOne(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE memory_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE memory_agents (
      role_id TEXT PRIMARY KEY,
      handle_json TEXT NOT NULL CHECK (json_valid(handle_json)),
      persona_json TEXT NOT NULL CHECK (json_valid(persona_json)),
      metrics_json TEXT NOT NULL CHECK (json_valid(metrics_json))
    );

    CREATE TABLE memory_skills (
      id TEXT PRIMARY KEY,
      role_id TEXT NOT NULL REFERENCES memory_agents(role_id) ON DELETE CASCADE,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      created_at TEXT NOT NULL
    );

    CREATE INDEX memory_skills_by_role_created
      ON memory_skills(role_id, created_at, id);

    CREATE TABLE memory_experiences (
      id TEXT PRIMARY KEY,
      role_id TEXT NOT NULL REFERENCES memory_agents(role_id) ON DELETE CASCADE,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      created_at TEXT NOT NULL
    );

    CREATE INDEX memory_experiences_by_role_created
      ON memory_experiences(role_id, created_at, id);
  `);
  database
    .prepare('INSERT INTO memory_schema_migrations(version, applied_at) VALUES (?, ?)')
    .run(1, new Date().toISOString());
}

function readCurrentVersion(database: DatabaseSync): number {
  const row = database
    .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM memory_schema_migrations')
    .get() as Record<string, unknown>;
  const version = row.version;
  if (typeof version !== 'number') throw new Error('Invalid SQLite memory schema version');
  return version;
}

function ensureEmbeddingDimensions(database: DatabaseSync, dimensions: number): void {
  const row = database
    .prepare("SELECT value FROM memory_metadata WHERE key = 'embedding_dimensions'")
    .get() as Record<string, unknown> | undefined;
  if (!row) {
    database
      .prepare("INSERT INTO memory_metadata(key, value) VALUES ('embedding_dimensions', ?)")
      .run(String(dimensions));
    return;
  }

  const stored = Number(row.value);
  if (stored !== dimensions) {
    throw new Error(
      `SQLite memory embedding dimensions mismatch: stored ${String(stored)}, configured ${String(dimensions)}`,
    );
  }
}
