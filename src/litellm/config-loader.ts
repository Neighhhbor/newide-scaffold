/**
 * ================================================
 * Config Loader — reads litellm config directory
 * ================================================
 *
 * Configuration lives in a directory of .yaml files.
 * Each developer can own their method's config in a separate file —
 * no merge conflicts.
 *
 *   config/
 *   ├── defaults.yaml      # Global defaults
 *   ├── profiles.yaml      # Reusable model profiles
 *   └── <task>.yaml        # Per-method config (add yours here)
 *
 * All files are merged. Profiles are merged by name across files.
 * Tasks are resolved against the fully merged profiles.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as parseYaml } from 'js-yaml';
import type {
  LiteLLMTaskConfig,
  ModelProfile,
  ModelEntry,
  ModelSelectionStrategy,
} from './contract';

// ──────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────

export interface LitellmConfigResult {
  defaults: {
    timeoutMs: number;
    maxRetries: number;
    temperature: number;
    maxTokens: number;
  };
  profiles: Record<string, ModelProfile>;
  tasks: LiteLLMTaskConfig[];
}

/**
 * Load and merge all .yaml files from the config directory.
 */
export function loadLitellmConfig(dirPath?: string): LitellmConfigResult {
  const resolvedDir = dirPath ?? defaultConfigDir();
  const entries = readdirSync(resolvedDir, { withFileTypes: true });
  const yamlFiles = entries
    .filter((e) => e.isFile() && (extname(e.name) === '.yaml' || extname(e.name) === '.yml'))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => resolve(resolvedDir, e.name));

  if (yamlFiles.length === 0) {
    throw new Error(`No .yaml files found in ${resolvedDir}`);
  }

  // Pass 1: extract raw data from all files
  const allDefaults: Array<Partial<LitellmConfigResult['defaults']>> = [];
  const allProfiles: Record<string, ModelProfile> = {};
  const rawTasks: Array<RawTask & { taskName: string }> = [];

  for (const filePath of yamlFiles) {
    const text = readFileSync(filePath, 'utf-8');
    const raw = parseYaml(text) as RawFile | null;
    if (!raw || typeof raw !== 'object') continue;
    if (raw.defaults) allDefaults.push(raw.defaults);
    if (raw.profiles) {
      Object.assign(allProfiles, parseProfiles(raw.profiles));
    }
    if (raw.tasks) {
      for (const [taskName, task] of Object.entries(raw.tasks)) {
        if (task && typeof task === 'object') {
          rawTasks.push({ ...task, taskName });
        }
      }
    }
  }

  // Merge defaults
  const defaults: LitellmConfigResult['defaults'] = {
    timeoutMs: 30000,
    maxRetries: 3,
    temperature: 0.3,
    maxTokens: 2000,
  };
  for (const d of allDefaults) {
    Object.assign(defaults, d);
  }

  // Pass 2: resolve all tasks against the fully merged profiles
  const tasks: LiteLLMTaskConfig[] = [];
  for (const task of rawTasks) {
    tasks.push(resolveTask(task.taskName, task, allProfiles));
  }

  return { defaults, profiles: allProfiles, tasks };
}

// ──────────────────────────────────────────────────────────
// Parsing helpers
// ──────────────────────────────────────────────────────────

interface RawProfile {
  strategy?: ModelSelectionStrategy;
  timeoutMs?: number;
  maxRetries?: number;
  temperature?: number;
  maxTokens?: number;
  models?: ModelEntry[];
}

interface RawTask {
  profile?: string;
  strategy?: ModelSelectionStrategy;
  timeoutMs?: number;
  maxRetries?: number;
  temperature?: number;
  maxTokens?: number;
  models?: ModelEntry[];
}

interface RawFile {
  defaults?: Partial<LitellmConfigResult['defaults']>;
  profiles?: Record<string, RawProfile>;
  tasks?: Record<string, RawTask>;
}

function parseProfiles(raw: Record<string, RawProfile>): Record<string, ModelProfile> {
  const profiles: Record<string, ModelProfile> = {};
  for (const [name, p] of Object.entries(raw)) {
    if (!p || typeof p !== 'object') continue;
    const profile: ModelProfile = { models: p.models ?? [] };
    if (p.strategy !== undefined) profile.strategy = p.strategy;
    if (p.timeoutMs !== undefined) profile.timeoutMs = p.timeoutMs;
    if (p.maxRetries !== undefined) profile.maxRetries = p.maxRetries;
    if (p.temperature !== undefined) profile.temperature = p.temperature;
    if (p.maxTokens !== undefined) profile.maxTokens = p.maxTokens;
    profiles[name] = profile;
  }
  return profiles;
}

function resolveTask(
  taskName: string,
  task: RawTask,
  profiles: Record<string, ModelProfile>,
): LiteLLMTaskConfig {
  const profile = task.profile ? profiles[task.profile] : undefined;

  if (task.profile && !profile) {
    throw new Error(
      `Task "${taskName}" references unknown profile "${task.profile}". ` +
        `Available profiles: [${Object.keys(profiles).join(', ')}]`,
    );
  }

  if (!profile && !task.models?.length) {
    throw new Error(
      `Task "${taskName}" has no models and no profile. ` +
        `Set "profile: <name>" or list "models:" explicitly.`,
    );
  }

  const t: LiteLLMTaskConfig = {
    task: taskName,
    models: task.models ?? profile?.models ?? [],
    strategy: task.strategy ?? profile?.strategy ?? 'order',
  };
  if (task.profile !== undefined) t.profile = task.profile;

  const timeout = task.timeoutMs ?? profile?.timeoutMs;
  if (timeout !== undefined) t.timeoutMs = timeout;
  const retries = task.maxRetries ?? profile?.maxRetries;
  if (retries !== undefined) t.maxRetries = retries;
  const temp = task.temperature ?? profile?.temperature;
  if (temp !== undefined) t.temperature = temp;
  const tokens = task.maxTokens ?? profile?.maxTokens;
  if (tokens !== undefined) t.maxTokens = tokens;

  return t;
}

function defaultConfigDir(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return resolve(moduleDir, 'config');
}
