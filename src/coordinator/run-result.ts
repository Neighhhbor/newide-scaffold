/**
 * Coordinator 运行结果清单模块。
 *
 * 这个文件只负责构建和写入 `.newide/runs/<run_id>/result.json`。
 * `result.json` 是给 CLI、UI、人工 review 或后续模块读取的稳定入口，
 * 避免调用方同时解析 summary/timeline/checkpoint 多个文件。
 */
import { promises as fs } from 'node:fs';
import type { SchemaVersion, TaskId, RunId, Timestamp } from '../core';
import type { SelectionMode } from './artifact-finalizer';
import type { ArtifactOutput } from './artifact-output';

export type RunResultStatus = 'completed' | 'failed';

export interface IntegrationRunResultManifest {
  run_id: RunId;
  task_id: TaskId;
  status: RunResultStatus;
  mode: SelectionMode;
  driver_id: string;
  artifact_outputs: ArtifactOutput[];
  summary_path: string;
  timeline_path: string;
  checkpoint_path: string;
  created_at: Timestamp;
  schema_version: SchemaVersion;
}

export interface BuildRunResultManifestInput {
  run_id: RunId;
  task_id: TaskId;
  status: RunResultStatus;
  mode: SelectionMode;
  driver_id: string;
  artifact_outputs: readonly ArtifactOutput[];
  summary_path: string;
  timeline_path: string;
  checkpoint_path: string;
  created_at: Timestamp;
  schema_version: SchemaVersion;
}

export function buildRunResultManifest(
  input: BuildRunResultManifestInput,
): IntegrationRunResultManifest {
  return {
    run_id: input.run_id,
    task_id: input.task_id,
    status: input.status,
    mode: input.mode,
    driver_id: input.driver_id,
    artifact_outputs: [...input.artifact_outputs],
    summary_path: input.summary_path,
    timeline_path: input.timeline_path,
    checkpoint_path: input.checkpoint_path,
    created_at: input.created_at,
    schema_version: input.schema_version,
  };
}

export async function writeRunResultManifest(
  filePath: string,
  manifest: IntegrationRunResultManifest,
): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(manifest, null, 2), 'utf-8');
}
