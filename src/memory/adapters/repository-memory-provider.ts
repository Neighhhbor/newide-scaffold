/**
 * RepositoryMemoryProvider — MemoryProvider 的生产向实现
 *
 * 从 MemoryRepository 检索 skill / experience，装配 ContextPack（memory_refs + summary）。
 * 检索链与 Agent 内部 buildDriverContext 共用 retrieveMemoriesForTask。
 */
import { SCHEMA_VERSION, createId, nowTimestamp, type MemoryRef } from '../../core';
import type { BuildContextPackInput, ContextPack, MemoryProvider } from '../contract';
import type { BufferRepository } from '../ports/buffer-repository';
import type { EmbeddingProvider } from '../ports/embedding-provider';
import type { MemoryRepository } from '../ports/memory-repository';
import type { ExperienceRecord, SkillRecord } from '../schemas';
import type { MemoryRetrievalResult } from '../services/memory-query';
import { createAgentMemoryScope } from './agent-memory-scope';
import { defaultHashEmbeddingProvider } from './hash-embedding-provider';
import { retrieveMemoriesForTask } from './memory-retrieval';

export class RepositoryMemoryProvider implements MemoryProvider {
  private readonly embedding: EmbeddingProvider;

  constructor(
    private readonly repository: MemoryRepository,
    private readonly bufferRepository: BufferRepository,
    embedding?: EmbeddingProvider,
  ) {
    this.embedding = embedding ?? defaultHashEmbeddingProvider;
  }

  async buildContextPack(input: BuildContextPackInput): Promise<ContextPack> {
    const role_id = input.role_profile_ref.role_id;
    const scope = createAgentMemoryScope(this.repository, this.bufferRepository, role_id);
    const task_query = input.summary_hint ?? '';

    const retrieval = await retrieveMemoriesForTask(
      scope,
      { task_query },
      {
        embedding: this.embedding,
        selection: {
          max_memory_items: input.role_profile_ref.memory_policy.max_memory_items,
        },
      },
    );

    const memory_refs = mapRetrievalToMemoryRefs(role_id, retrieval);
    const summary = buildContextPackSummary(input.task_id, retrieval);

    return {
      context_pack_id: createId('context_pack'),
      task_id: input.task_id,
      role_profile_ref: input.role_profile_ref,
      memory_refs,
      artifact_refs: input.artifact_refs ?? [],
      summary,
      created_at: nowTimestamp(),
      schema_version: SCHEMA_VERSION,
    };
  }
}

function mapRetrievalToMemoryRefs(role_id: string, retrieval: MemoryRetrievalResult): MemoryRef[] {
  const skillRefs = retrieval.skills.map((skill) => toSkillMemoryRef(role_id, skill));
  const experienceRefs = retrieval.experiences.map((experience) =>
    toExperienceMemoryRef(role_id, experience),
  );
  return [...skillRefs, ...experienceRefs];
}

function toSkillMemoryRef(role_id: string, skill: SkillRecord): MemoryRef {
  return {
    memory_id: skill.id,
    kind: 'skill',
    uri: `memory://${role_id}/skill/${skill.id}`,
    summary: skill.description,
    schema_version: SCHEMA_VERSION,
  };
}

function toExperienceMemoryRef(role_id: string, experience: ExperienceRecord): MemoryRef {
  return {
    memory_id: experience.id,
    kind: 'experience',
    uri: `memory://${role_id}/experience/${experience.id}`,
    summary: experience.description,
    schema_version: SCHEMA_VERSION,
  };
}

function buildContextPackSummary(task_id: string, retrieval: MemoryRetrievalResult): string {
  const skillCount = retrieval.skills.length;
  const experienceCount = retrieval.experiences.length;
  const total = skillCount + experienceCount;

  if (total === 0) {
    return `No memories retrieved for task ${task_id}`;
  }

  return `Retrieved ${total} memories (${skillCount} skills, ${experienceCount} experiences) for task ${task_id}`;
}
