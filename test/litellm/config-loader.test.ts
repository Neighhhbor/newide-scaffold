import { describe, it, expect, afterAll } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLitellmConfig } from '../../src/litellm/contract';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMP_DIR = resolve(__dirname, '__tmp-config');

afterAll(() => {
  try {
    rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    /* ok */
  }
});

function setupDir(): void {
  rmSync(TMP_DIR, { recursive: true, force: true });
  mkdirSync(TMP_DIR, { recursive: true });
}

function writeConfig(filename: string, content: string): void {
  writeFileSync(resolve(TMP_DIR, filename), content, 'utf-8');
}

describe('loadLitellmConfig', () => {
  it('should parse defaults, profiles, and tasks from a config directory', () => {
    setupDir();
    writeConfig(
      'defaults.yaml',
      `
defaults:
  timeoutMs: 30000
  maxRetries: 3
  temperature: 0.3
  maxTokens: 2000
`,
    );
    writeConfig(
      'profiles.yaml',
      `
profiles:
  cheap:
    strategy: cheapest
    models:
      - provider: openai
        model: gpt-4o-mini
        order: 1
        costPer1kTokens: 0.00015
      - provider: anthropic
        model: claude-haiku
        order: 2
        costPer1kTokens: 0.00025
`,
    );
    writeConfig(
      'tasks.yaml',
      `
tasks:
  memory-query:
    profile: cheap
    timeoutMs: 10000

  classify-intent:
    profile: cheap
    maxTokens: 500
`,
    );

    const { defaults, profiles, tasks } = loadLitellmConfig(TMP_DIR);

    // defaults
    expect(defaults.timeoutMs).toBe(30000);

    // profiles
    expect(profiles.cheap).toBeDefined();
    expect(profiles.cheap!.strategy).toBe('cheapest');
    expect(profiles.cheap!.models).toHaveLength(2);

    // tasks
    expect(tasks).toHaveLength(2);

    const query = tasks.find((t) => t.task === 'memory-query')!;
    expect(query.profile).toBe('cheap');
    expect(query.timeoutMs).toBe(10000);
    expect(query.models).toHaveLength(2);

    const cls = tasks.find((t) => t.task === 'classify-intent')!;
    expect(cls.maxTokens).toBe(500);
  });

  it('should override profile fields at task level', () => {
    setupDir();
    writeConfig(
      'override-test.yaml',
      `
profiles:
  base:
    strategy: order
    models:
      - provider: openai
        model: test-model
        order: 1

tasks:
  my-task:
    profile: base
    timeoutMs: 5000
`,
    );

    const { tasks } = loadLitellmConfig(TMP_DIR);
    const t = tasks.find((t) => t.task === 'my-task')!;
    expect(t.timeoutMs).toBe(5000);
    expect(t.strategy).toBe('order'); // inherited
  });

  it('should throw on unknown profile reference', () => {
    setupDir();
    writeConfig(
      'bad-task.yaml',
      `
tasks:
  bad-task:
    profile: nonexistent
    models: []
`,
    );

    expect(() => loadLitellmConfig(TMP_DIR)).toThrow('unknown profile');
  });

  it('should throw when a task has no models and no profile', () => {
    setupDir();
    writeConfig(
      'no-models.yaml',
      `
tasks:
  empty-task: {}
`,
    );

    expect(() => loadLitellmConfig(TMP_DIR)).toThrow('no models and no profile');
  });

  it('should load the bundled config directory without errors', () => {
    const { defaults, tasks } = loadLitellmConfig(); // default path

    expect(defaults.timeoutMs).toBeGreaterThan(0);
    expect(tasks.length).toBeGreaterThanOrEqual(3);
    for (const t of tasks) {
      expect(t.models.length).toBeGreaterThan(0);
      expect(t.task).toBeTruthy();
    }
  });
});
