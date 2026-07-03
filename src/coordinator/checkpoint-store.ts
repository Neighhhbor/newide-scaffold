import type { Checkpoint, CheckpointId, RunId } from '../core';
import type { CheckpointStore } from '../core';

export class InMemoryCheckpointStore implements CheckpointStore {
  private readonly checkpoints = new Map<CheckpointId, Checkpoint>();

  save(checkpoint: Checkpoint): Checkpoint {
    this.checkpoints.set(checkpoint.checkpoint_id, checkpoint);
    return checkpoint;
  }

  get(checkpointId: CheckpointId): Checkpoint | undefined {
    return this.checkpoints.get(checkpointId);
  }

  getLatestByRun(runId: RunId): Checkpoint | undefined {
    let latest: Checkpoint | undefined;
    for (const checkpoint of this.checkpoints.values()) {
      if (checkpoint.run_id !== runId) continue;
      if (checkpoint.validity_status === 'superseded') continue;
      if (latest === undefined || checkpoint.created_at > latest.created_at) {
        latest = checkpoint;
      }
    }
    return latest;
  }

  listByRun(runId: RunId): Checkpoint[] {
    return this.checkpointsByRun(runId);
  }

  list(): Checkpoint[] {
    return [...this.checkpoints.values()].sort(byCreatedAtAsc);
  }

  private checkpointsByRun(runId: RunId): Checkpoint[] {
    return [...this.checkpoints.values()]
      .filter((checkpoint) => checkpoint.run_id === runId)
      .sort(byCreatedAtAsc);
  }
}

function byCreatedAtAsc(a: Checkpoint, b: Checkpoint): number {
  if (a.created_at === b.created_at) return 0;
  return a.created_at < b.created_at ? -1 : 1;
}
