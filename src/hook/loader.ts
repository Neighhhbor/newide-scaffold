import { parse as parseYaml } from 'yaml';
import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

import type { HookConfig, HookSettings, GateConfig, HookBindingEntry } from './config';
import {
  ALL_HOOK_POINTS,
  DEFAULT_HOOK_VERSION,
  DEFAULT_HOOK_SETTINGS,
//  DEFAULT_PRIORITY,
} from './constants';
import type { GateDecision, SubGateRef } from '../gate';

// ──────────────────────────────────────────────
// Error types
// ──────────────────────────────────────────────

/** Aggregated validation errors thrown by {@link validateHookConfig} */
export class HookConfigValidationError extends Error {
  public readonly errors: string[];

  constructor(errors: string[]) {
    super(`Hook config validation failed with ${errors.length} error(s):\n${errors.map((e) => `  - ${e}`).join('\n')}`);
    this.name = 'HookConfigValidationError';
    this.errors = errors;
  }
}

// ──────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────

/**
 * Parse a YAML string into a validated {@link HookConfig}.
 *
 * @throws {HookConfigValidationError} When the parsed config fails validation.
 * @throws {Error} When the YAML string itself is syntactically invalid.
 */
export function parseHookConfigYaml(yamlContent: string): HookConfig {
  let raw: unknown;
  try {
    raw = parseYaml(yamlContent);
  } catch (cause) {
    throw new Error(`Failed to parse YAML content: ${String(cause)}`, { cause });
  }
  return validateHookConfig(raw);
}

/**
 * Read a YAML file from disk and parse it into a validated {@link HookConfig}.
 *
 * @throws {HookConfigValidationError} When the parsed config fails validation.
 * @throws {Error} When the file cannot be read or contains invalid YAML.
 */
export function loadHookConfigFromFile(filePath: string): HookConfig {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (cause) {
    throw new Error(`Failed to read hook config file "${filePath}": ${String(cause)}`, { cause });
  }

  let raw: unknown;
  try {
    raw = parseYaml(content);
  } catch (cause) {
    throw new Error(`Failed to parse YAML in "${filePath}": ${String(cause)}`, { cause });
  }

  return validateHookConfig(raw, filePath);
}

/**
 * Options for {@link loadMergedHookConfig}.
 */
export interface LoadMergedOptions {
  /**
   * Project root directory.
   * @default process.cwd()
   */
  projectRoot?: string;
}

/**
 * Load hook configuration using the three-layer merge strategy defined in RFC §5.1.
 *
 * Layers (later overrides earlier):
 * 1. `<projectRoot>/.agent/hooks.yaml`   — project-level (team-shared, version-controlled)
 * 2. `~/.agent/hooks.yaml`               — user-level (personal preference)
 * 3. `~/.agent/hooks.local.yaml`         — local-level (not committed, personal override)
 *
 * Merge rules:
 * - `settings`: shallow merge, later layer wins per key
 * - `gates`:    spread merge, later layer's gate of the same name overwrites
 * - `hooks`:    per-event append — bindings from later layers are appended after earlier ones
 *
 * Missing layers are silently skipped. At least one layer must be present.
 *
 * @throws {Error} When no configuration layer is found.
 * @throws {HookConfigValidationError} When a layer fails validation.
 */
export function loadMergedHookConfig(options: LoadMergedOptions = {}): HookConfig {
  const projectRoot = options.projectRoot ?? process.cwd();
  const home = homedir();

  const layers: Array<{ path: string; required: boolean }> = [
    { path: join(projectRoot, '.agent', 'hooks.yaml'), required: false },
    { path: join(home, '.agent', 'hooks.yaml'), required: false },
    { path: join(home, '.agent', 'hooks.local.yaml'), required: false },
  ];

  let merged: HookConfig | null = null;

  for (const layer of layers) {
    if (!existsSync(layer.path)) {
      continue;
    }
    const config = loadHookConfigFromFile(layer.path);

    if (merged === null) {
      merged = config;
    } else {
      merged = mergeHookConfigs(merged, config);
    }
  }

  if (merged === null) {
    throw new Error(
      'No hook configuration found. Expected at least one of:\n' +
        layers.map((l) => `  - ${l.path}`).join('\n'),
    );
  }

  return merged;
}

/**
 * Merge two {@link HookConfig} objects with the following rules:
 * - `settings`: shallow merge (override wins per key)
 * - `gates`:    spread merge (override's gate of the same name replaces base's)
 * - `hooks`:    per-event append — override bindings are appended after base bindings
 */
export function mergeHookConfigs(base: HookConfig, override: HookConfig): HookConfig {
  return {
    version: override.version,
    settings: { ...base.settings, ...override.settings },
    gates: { ...base.gates, ...override.gates },
    hooks: mergeHooksSection(base.hooks, override.hooks),
  };
}

// ──────────────────────────────────────────────
// Validation
// ──────────────────────────────────────────────

const VALID_GATE_TYPES = new Set(['command', 'prompt', 'composite', 'http']);
const VALID_HOOK_POINTS = new Set<string>(ALL_HOOK_POINTS);
const PRIORITY_MIN = 1;
const PRIORITY_MAX = 999;

/**
 * Validate a raw (post-YAML-parse) value against the {@link HookConfig} schema.
 *
 * Validation rules (RFC §9.2):
 * - Top-level must be an object with optional `version`, `settings`, `gates`, `hooks`
 * - Missing `settings` keys are filled from {@link DEFAULT_HOOK_SETTINGS}
 * - Every gate referenced in `hooks` must exist in `gates`
 * - Every event name in `hooks` must be a known {@link HookPoint}
 * - `priority` is clamped to [1, 999]
 * - Invalid `if` expression syntax is warned (fail-closed: treated as false at runtime)
 *
 * @param raw          The value returned by `yaml.parse()`.
 * @param _sourcePath  Optional file path used in error messages (not used for reading).
 * @throws {HookConfigValidationError} When validation fails.
 */
export function validateHookConfig(raw: unknown, _sourcePath?: string): HookConfig {
  const errors: string[] = [];
  const prefix = _sourcePath ? `[${_sourcePath}] ` : '';

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new HookConfigValidationError([`${prefix}Config must be a YAML object, got ${Array.isArray(raw) ? 'array' : typeof raw}`]);
  }

  const obj = raw as Record<string, unknown>;

  // ── version ──────────────────────────────────
  const version = typeof obj['version'] === 'string' ? obj['version'] : DEFAULT_HOOK_VERSION;

  // ── settings ─────────────────────────────────
  const settings = parseSettings(obj['settings'], errors, prefix);

  // ── gates ────────────────────────────────────
  const gates = parseGates(obj['gates'], errors, prefix);

  // ── hooks ────────────────────────────────────
  const hooks = parseHookBindings(obj['hooks'], gates, errors, prefix);

  if (errors.length > 0) {
    throw new HookConfigValidationError(errors);
  }

  return { version, settings, gates, hooks };
}

// ──────────────────────────────────────────────
// Internal parsing helpers
// ──────────────────────────────────────────────

function parseSettings(
  raw: unknown,
  errors: string[],
  prefix: string,
): HookSettings {
  if (raw === undefined || raw === null) {
    return { ...DEFAULT_HOOK_SETTINGS };
  }

  if (typeof raw !== 'object') {
    errors.push(`${prefix}settings must be an object, got ${typeof raw}`);
    return { ...DEFAULT_HOOK_SETTINGS };
  }

  const s = raw as Record<string, unknown>;
  const result = { ...DEFAULT_HOOK_SETTINGS };

  if (typeof s['fail_fast'] === 'boolean') result.fail_fast = s['fail_fast'];
  if (typeof s['default_timeout'] === 'number') result.default_timeout = s['default_timeout'];
  if (typeof s['parallel'] === 'boolean') result.parallel = s['parallel'];
  if (typeof s['output_format'] === 'string') result.output_format = s['output_format'];
  if (typeof s['emergency_env_var'] === 'string') result.emergency_env_var = s['emergency_env_var'];

  return result;
}

function parseGates(
  raw: unknown,
  errors: string[],
  prefix: string,
): Record<string, GateConfig> {
  if (raw === undefined || raw === null) {
    return {};
  }

  if (typeof raw !== 'object') {
    errors.push(`${prefix}gates must be an object, got ${typeof raw}`);
    return {};
  }

  const gatesObj = raw as Record<string, unknown>;
  const gates: Record<string, GateConfig> = {};

  for (const [name, gateRaw] of Object.entries(gatesObj)) {
    gates[name] = parseGateConfig(name, gateRaw, errors, prefix);
  }

  return gates;
}

function parseGateConfig(
  name: string,
  raw: unknown,
  errors: string[],
  prefix: string,
): GateConfig {
  if (typeof raw !== 'object' || raw === null) {
    errors.push(`${prefix}gates.${name} must be an object, got ${typeof raw}`);
    return { type: 'command' } as GateConfig;
  }

  const g = raw as Record<string, unknown>;
  const type = g['type'];

  if (typeof type !== 'string' || !VALID_GATE_TYPES.has(type)) {
    errors.push(
      `${prefix}gates.${name}.type must be one of [${[...VALID_GATE_TYPES].join(', ')}], got "${String(type)}"`,
    );
  }

  const gate: GateConfig = {
    type: (VALID_GATE_TYPES.has(type as string) ? type : 'command') as GateConfig['type'],
  };

  // run — semantics differ by gate type (command string, prompt text, http URL)
  if (typeof g['run'] === 'string') gate.run = g['run'];

  // model — only meaningful for prompt-type gates
  if (typeof g['model'] === 'string') gate.model = g['model'];

  // gates — sub-gate references for composite type
  // YAML uses `gate` field name; SubGateRef uses `gate_id`
  if (Array.isArray(g['gates'])) {
    gate.gates = g['gates'].map((item: unknown, idx: number) => parseSubGateRef(item, name, idx, errors, prefix));
  }

  // output
  if (typeof g['output'] === 'object' && g['output'] !== null) {
    const out = g['output'] as Record<string, unknown>;
    gate.output = {};
    if (typeof out['format'] === 'string') gate.output.format = out['format'];
  }

  // severity_map
  if (typeof g['severity_map'] === 'object' && g['severity_map'] !== null) {
    const sm = g['severity_map'] as Record<string, unknown>;
    gate.severity_map = {};
    for (const [sev, decision] of Object.entries(sm)) {
      if (typeof decision === 'string') {
        gate.severity_map[sev] = decision as GateDecision;
      }
    }
  }

  if (typeof g['timeout'] === 'number') gate.timeout = g['timeout'];
  if (typeof g['retry_threshold'] === 'number') gate.retry_threshold = g['retry_threshold'];

  return gate;
}

function parseSubGateRef(
  item: unknown,
  gateName: string,
  idx: number,
  errors: string[],
  prefix: string,
): SubGateRef {
  if (typeof item === 'string') {
    // Short form: just the gate name as a string
    return { gate_id: item };
  }

  if (typeof item === 'object' && item !== null) {
    const obj = item as Record<string, unknown>;
    // YAML uses `gate` field; map to SubGateRef.gate_id
    const gateId =
      typeof obj['gate'] === 'string'
        ? obj['gate']
        : typeof obj['gate_id'] === 'string'
          ? obj['gate_id']
          : undefined;

    if (!gateId) {
      errors.push(
        `${prefix}gates.${gateName}.gates[${idx}] must have a "gate" field referencing a gate name`,
      );
    }

    const ref: SubGateRef = { gate_id: gateId ?? '' };
    if (typeof obj['required'] === 'boolean') ref.required = obj['required'];
    return ref;
  }

  errors.push(
    `${prefix}gates.${gateName}.gates[${idx}] must be a string or object, got ${typeof item}`,
  );
  return { gate_id: '' };
}

function parseHookBindings(
  raw: unknown,
  gates: Record<string, GateConfig>,
  errors: string[],
  prefix: string,
): HookConfig['hooks'] {
  if (raw === undefined || raw === null) {
    return {};
  }

  if (typeof raw !== 'object') {
    errors.push(`${prefix}hooks must be an object, got ${typeof raw}`);
    return {};
  }

  const hooksObj = raw as Record<string, unknown>;
  const hooks: Record<string, HookBindingEntry[]> = {};

  for (const [eventName, bindingsRaw] of Object.entries(hooksObj)) {
    // Validate event name
    if (!VALID_HOOK_POINTS.has(eventName)) {
      errors.push(
        `${prefix}hooks.${eventName}: unknown event name. Valid hook points include: ${ALL_HOOK_POINTS.join(', ')}`,
      );
    }

    if (!Array.isArray(bindingsRaw)) {
      errors.push(
        `${prefix}hooks.${eventName} must be an array of binding entries, got ${typeof bindingsRaw}`,
      );
      continue;
    }

    const entries: HookBindingEntry[] = [];
    for (let i = 0; i < bindingsRaw.length; i++) {
      entries.push(parseBindingEntry(eventName, i, bindingsRaw[i], gates, errors, prefix));
    }
    hooks[eventName] = entries;
  }

  return hooks as HookConfig['hooks'];
}

function parseBindingEntry(
  eventName: string,
  idx: number,
  raw: unknown,
  gates: Record<string, GateConfig>,
  errors: string[],
  prefix: string,
): HookBindingEntry {
  const loc = `${prefix}hooks.${eventName}[${idx}]`;

  if (typeof raw !== 'object' || raw === null) {
    errors.push(`${loc} must be an object, got ${typeof raw}`);
    return { gate: '' };
  }

  const b = raw as Record<string, unknown>;

  // gate — required reference to a defined gate
  const gateRef = typeof b['gate'] === 'string' ? b['gate'] : undefined;
  if (!gateRef) {
    errors.push(`${loc}: missing required field "gate"`);
  } else if (!(gateRef in gates)) {
    errors.push(
      `${loc}: references gate "${gateRef}" which is not defined in the gates section. ` +
        `Defined gates: [${Object.keys(gates).join(', ') || '(none)'}]`,
    );
  }

  const entry: HookBindingEntry = {
    gate: gateRef ?? '',
  };

  // name — optional human-readable label
  if (typeof b['name'] === 'string') entry.name = b['name'];

  // priority — clamp to [1, 999]
  if (typeof b['priority'] === 'number') {
    if (b['priority'] < PRIORITY_MIN || b['priority'] > PRIORITY_MAX) {
      const clamped = Math.max(PRIORITY_MIN, Math.min(PRIORITY_MAX, b['priority']));
      errors.push(`${loc}: priority ${b['priority']} out of range [${PRIORITY_MIN}, ${PRIORITY_MAX}], clamped to ${clamped}`);
      entry.priority = clamped;
    } else {
      entry.priority = b['priority'];
    }
  }

  // if — condition expression
  if (typeof b['if'] === 'string') {
    entry.if = b['if'];
  }

  // timeout — per-binding override in seconds
  if (typeof b['timeout'] === 'number') {
    entry.timeout = b['timeout'];
  }

  // on_failure — fallback decision
  if (typeof b['on_failure'] === 'string') {
    entry.on_failure = b['on_failure'] as GateDecision;
  }

  return entry;
}

// ──────────────────────────────────────────────
// Internal utilities
// ──────────────────────────────────────────────

function mergeHooksSection(
  base: HookConfig['hooks'],
  override: HookConfig['hooks'],
): HookConfig['hooks'] {
  const merged: Record<string, HookBindingEntry[]> = { ...base };

  for (const [eventName, entries] of Object.entries(override)) {
    if (merged[eventName]) {
      merged[eventName] = [...merged[eventName]!, ...entries];
    } else {
      merged[eventName] = entries;
    }
  }

  return merged as HookConfig['hooks'];
}
