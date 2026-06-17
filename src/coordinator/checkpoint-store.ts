import type { Checkpoint, CheckpointId } from '../core';

export class InMemoryCheckpointStore {
  private readonly checkpoints = new Map<CheckpointId, Checkpoint>();

  save(checkpoint: Checkpoint): Checkpoint {
    this.checkpoints.set(checkpoint.checkpoint_id, checkpoint);
    return checkpoint;
  }

  get(checkpointId: CheckpointId): Checkpoint | undefined {
    return this.checkpoints.get(checkpointId);
  }

  list(): Checkpoint[] {
    return [...this.checkpoints.values()];
  }
}
