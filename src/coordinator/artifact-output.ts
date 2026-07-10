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

    return output;
  });
}

function readStringMetadata(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
