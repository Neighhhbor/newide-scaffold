/**
 * ================================================
 * Config Loader — reads litellm-config.yaml
 * ================================================
 * Includes a minimal YAML parser for the subset
 * used by our task→model configuration format.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LiteLLMTaskConfig, ModelEntry, ModelSelectionStrategy } from './types';

// ──────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────

export interface LitellmConfigFile {
  defaults: {
    timeoutMs: number;
    maxRetries: number;
    temperature: number;
    maxTokens: number;
  };
  tasks: Record<
    string,
    {
      strategy?: ModelSelectionStrategy;
      timeoutMs?: number;
      maxRetries?: number;
      temperature?: number;
      maxTokens?: number;
      models: ModelEntry[];
    }
  >;
}

/**
 * Load a litellm-config.yaml file and return typed task configs.
 *
 * @param filePath Absolute or relative path to the YAML config file.
 *                 If omitted, loads the default `litellm-config.yaml`
 *                 shipped alongside this module.
 */
export function loadLitellmConfig(filePath?: string): {
  defaults: LitellmConfigFile['defaults'];
  tasks: LiteLLMTaskConfig[];
} {
  const resolvedPath = filePath ?? defaultConfigPath();
  const text = readFileSync(resolvedPath, 'utf-8');
  const raw = parseConfigYaml(text) as unknown as LitellmConfigFile;

  const defaults = raw.defaults;

  const tasks: LiteLLMTaskConfig[] = Object.entries(raw.tasks).map(([taskName, cfg]) => {
    const t: LiteLLMTaskConfig = {
      task: taskName,
      models: cfg.models,
    };
    if (cfg.strategy !== undefined) t.strategy = cfg.strategy;
    if (cfg.timeoutMs !== undefined) t.timeoutMs = cfg.timeoutMs;
    if (cfg.maxRetries !== undefined) t.maxRetries = cfg.maxRetries;
    if (cfg.temperature !== undefined) t.temperature = cfg.temperature;
    if (cfg.maxTokens !== undefined) t.maxTokens = cfg.maxTokens;
    return t;
  });

  return { defaults, tasks };
}

// ──────────────────────────────────────────────────────────
// Minimal YAML parser (handles our config subset only)
// ──────────────────────────────────────────────────────────

type YamlNode = Record<string, unknown>;

function parseConfigYaml(text: string): YamlNode {
  const lines = text.split('\n');
  const root: YamlNode = {};
  let i = 0;

  while (i < lines.length) {
    const indent = lineIndent(lines[i]!);
    const trimmed = lines[i]!.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      i++;
      continue;
    }

    if (indent === 0 && trimmed.endsWith(':')) {
      const key = trimmed.slice(0, -1);
      const [node, nextI] = parseScope(lines, i + 1, 2);
      root[key] = node;
      i = nextI;
    } else {
      i++;
    }
  }

  return root;
}

/**
 * Parse a scoped block — lines at `scopeIndent` relative to parent.
 * Returns [parsed node, index of next unprocessed line].
 */
function parseScope(lines: string[], start: number, scopeIndent: number): [YamlNode, number] {
  const node: YamlNode = {};
  let i = start;

  while (i < lines.length) {
    const line = lines[i]!;
    const indent = lineIndent(line);
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      i++;
      continue;
    }

    // Back to parent scope
    if (indent < scopeIndent) break;

    // Array: "- key: value" appearing directly in this scope (not nested under a key)
    if (indent === scopeIndent && trimmed.startsWith('- ')) {
      const [arr, nextI] = parseArray(lines, i, scopeIndent);
      // Find the key whose value was an empty array placeholder
      const key = findPendingArrayKey(node);
      if (key) node[key] = arr;
      i = nextI;
      continue;
    }

    // Nested scope: "key:" (no value after colon)
    if (indent === scopeIndent && trimmed.endsWith(':')) {
      const key = trimmed.slice(0, -1);
      // Peek: if next line is an array item at scopeIndent+2, parse it now
      const next = peekTrimmed(lines, i + 1);
      if (next && next.startsWith('- ') && indentOf(lines, i + 1) === scopeIndent + 2) {
        const [arr, nextI] = parseArray(lines, i + 1, scopeIndent + 2);
        node[key] = arr;
        i = nextI;
        continue;
      }
      // Regular nested object
      const [child, nextI] = parseScope(lines, i + 1, scopeIndent + 2);
      node[key] = child;
      i = nextI;
      continue;
    }

    // Scalar: "key: value"
    if (indent === scopeIndent && trimmed.includes(':')) {
      const colon = trimmed.indexOf(':');
      const key = trimmed.slice(0, colon).trim();
      const value = trimmed.slice(colon + 1).trim();
      node[key] = parseScalar(value);
    }

    i++;
  }

  return [node, i];
}

/**
 * Parse a sequence of "- key: value" / "- key:" items.
 */
function parseArray(
  lines: string[],
  start: number,
  scopeIndent: number,
): [Record<string, unknown>[], number] {
  const items: Record<string, unknown>[] = [];
  let current: Record<string, unknown> | null = null;
  let i = start;

  while (i < lines.length) {
    const line = lines[i]!;
    const indent = lineIndent(line);
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      i++;
      continue;
    }

    if (indent < scopeIndent) break;

    // New item: "- key: value"
    if (indent === scopeIndent && trimmed.startsWith('- ')) {
      current = {};
      items.push(current);
      const rest = trimmed.slice(2);
      if (rest.includes(':')) {
        const colon = rest.indexOf(':');
        const key = rest.slice(0, colon).trim();
        const value = rest.slice(colon + 1).trim();
        if (value) {
          current[key] = parseScalar(value);
        } else {
          // key: (no value) → nested scope
          const [nested, nextI] = parseScope(lines, i + 1, scopeIndent + 2);
          current[key] = nested;
          i = nextI;
          continue;
        }
      }
      i++;
      continue;
    }

    // Continuation property: "  key: value" at scopeIndent+2
    if (current && indent === scopeIndent + 2 && trimmed.includes(':')) {
      const colon = trimmed.indexOf(':');
      const key = trimmed.slice(0, colon).trim();
      const value = trimmed.slice(colon + 1).trim();
      current[key] = parseScalar(value);
      i++;
      continue;
    }

    i++;
  }

  return [items, i];
}

// ── Helpers ──

function lineIndent(line: string): number {
  return line.length - line.trimStart().length;
}

function indentOf(lines: string[], idx: number): number {
  return idx < lines.length ? lineIndent(lines[idx]!) : 0;
}

function peekTrimmed(lines: string[], start: number): string | null {
  for (let j = start; j < lines.length; j++) {
    const t = lines[j]!.trim();
    if (t && !t.startsWith('#')) return t;
  }
  return null;
}

function parseScalar(value: string): unknown {
  if (value === 'true' || value === 'True') return true;
  if (value === 'false' || value === 'False') return false;
  if (value === 'null' || value === '~') return null;
  if (/^-?\d+\.\d+$/.test(value)) return parseFloat(value);
  if (/^-?\d+$/.test(value)) return parseInt(value, 10);
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function findPendingArrayKey(node: YamlNode): string | null {
  for (const [k, v] of Object.entries(node)) {
    if (Array.isArray(v) && v.length === 0) return k;
  }
  return null;
}

// ──────────────────────────────────────────────────────────
// Default config path (alongside this module)
// ──────────────────────────────────────────────────────────

function defaultConfigPath(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return resolve(moduleDir, 'litellm-config.yaml');
}
