/**
 * Coordinator artifact 输出摘要模块。
 *
 * 这个文件只负责把已选择的 ArtifactRef 与 materializer 生成的本地记录路径
 * 整理成 summary/result 中可展示、可被上层消费的 artifact_outputs。
 * 它不负责选择 artifact，也不负责真正 apply patch 或写 worktree。
 */
import path from 'node:path';
import type { ArtifactRef } from '../core';

export interface ArtifactOutput {
  artifact_id: string;
  type: ArtifactRef['type'];
  uri: string;
  source_path?: string;
  materialized_path?: string;
  materialized_record_path?: string;
}

export interface BuildArtifactOutputsInput {
  artifacts: readonly ArtifactRef[];
  materialized_record_paths: readonly string[];
}

export function buildArtifactOutputs(input: BuildArtifactOutputsInput): ArtifactOutput[] {
  return input.artifacts.map((artifact) => {
    const output: ArtifactOutput = {
      artifact_id: artifact.artifact_id,
      type: artifact.type,
      uri: artifact.uri,
    };

    const sourcePath = readStringMetadata(artifact.metadata, 'path');
    if (sourcePath) {
      output.source_path = sourcePath;
    }

    const materializedRecordPath = input.materialized_record_paths.find((filePath) =>
      path.basename(filePath).startsWith(`${artifact.artifact_id}.`),
    );
    if (materializedRecordPath) {
      output.materialized_record_path = materializedRecordPath;
    }
    const materializedPath = findMaterializedPath(artifact, input.materialized_record_paths);
    if (materializedPath) output.materialized_path = materializedPath;

    return output;
  });
}

function findMaterializedPath(artifact: ArtifactRef, paths: readonly string[]): string | undefined {
  if (artifact.content?.target_path) {
    return paths.find((filePath) => filePath.endsWith(artifact.content!.target_path!));
  }
  if (artifact.content && paths.length === 1) return paths[0];
  return undefined;
}

function readStringMetadata(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
