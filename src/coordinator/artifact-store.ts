import type { ArtifactId, ArtifactRef } from '../core';

export class InMemoryArtifactStore {
  private readonly artifacts = new Map<ArtifactId, ArtifactRef>();

  register(artifact: ArtifactRef): ArtifactRef {
    this.artifacts.set(artifact.artifact_id, artifact);
    return artifact;
  }

  get(artifactId: ArtifactId): ArtifactRef | undefined {
    return this.artifacts.get(artifactId);
  }

  list(): ArtifactRef[] {
    return [...this.artifacts.values()];
  }
}
