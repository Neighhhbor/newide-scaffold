import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SCHEMA_VERSION, createId, nowTimestamp, type ArtifactRef, type TaskId } from '../core';

export interface MaterializationResult {
  materialization_id: string;
  task_id: TaskId;
  worktree_path: string;
  materialized_artifacts: ArtifactRef[];
  files_written: string[];
  created_at: string;
  schema_version: string;
}

export interface MaterializationInput {
  task_id: TaskId;
  artifacts: ArtifactRef[];
}

export interface WorktreeMaterializerOptions {
  baseWorktreePath: string;
}

/**
 * WorktreeMaterializer: Writes selected artifacts to worktree directory.
 *
 * Current implementation (v0):
 * - Creates .newide/worktrees/<task_id>/ directory
 * - Writes artifact metadata as JSON files
 * - Returns MaterializationResult with files_written, worktree_path, materialized_artifacts
 *
 * Future implementation:
 * - Apply patches to actual source files
 * - Create git worktrees
 * - Handle merge conflicts
 */
export class WorktreeMaterializer {
  private readonly options: WorktreeMaterializerOptions;

  constructor(options: WorktreeMaterializerOptions) {
    this.options = options;
  }

  async materialize(input: MaterializationInput): Promise<MaterializationResult> {
    const worktreePath = path.join(this.options.baseWorktreePath, input.task_id);

    // Create worktree directory
    await fs.mkdir(worktreePath, { recursive: true });

    const filesWritten: string[] = [];

    // Write each artifact to worktree
    for (const artifact of input.artifacts) {
      if (
        artifact.type === 'patch' ||
        artifact.type === 'diff' ||
        artifact.type === 'driver_result'
      ) {
        // v0: Write artifact metadata as JSON
        const artifactFile = path.join(worktreePath, `${artifact.artifact_id}.json`);
        await fs.writeFile(artifactFile, JSON.stringify(artifact, null, 2), 'utf-8');
        filesWritten.push(artifactFile);
      }

      // Other artifact types (transcript, context, etc.) are not materialized in v0
    }

    return {
      materialization_id: createId('materialization'),
      task_id: input.task_id,
      worktree_path: worktreePath,
      materialized_artifacts: input.artifacts,
      files_written: filesWritten,
      created_at: nowTimestamp(),
      schema_version: SCHEMA_VERSION,
    };
  }

  /**
   * Clean up worktree directory for a task.
   */
  async cleanup(taskId: TaskId): Promise<void> {
    const worktreePath = path.join(this.options.baseWorktreePath, taskId);
    try {
      await fs.rm(worktreePath, { recursive: true, force: true });
    } catch {
      // Ignore errors if directory doesn't exist
    }
  }
}

/**
 * Factory function to create a WorktreeMaterializer with default base path.
 *
 * @param baseWorktreePath - defaults to '.newide/worktrees'
 */
export function createWorktreeMaterializer(
  baseWorktreePath = '.newide/worktrees',
): WorktreeMaterializer {
  return new WorktreeMaterializer({ baseWorktreePath });
}
