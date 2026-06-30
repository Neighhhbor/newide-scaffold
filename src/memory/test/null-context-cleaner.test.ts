import { describe, it, expect } from 'vitest';
import { NullContextCleaner } from '../adapters/null-context-cleaner';
import { InMemoryRepository } from '../adapters/in-memory-repository';
import { InMemoryBufferRepository } from '../adapters/in-memory-buffer-repository';
import { createAgentMemoryScope } from '../adapters/agent-memory-scope';
import { runTaskMemoryCycle } from '../services/memory-cycle';
import type { AgentRunDeps } from '../runtime/agent-run-deps';
import type { AgentTaskRequest } from '../agent-types';

describe('NullContextCleaner', () => {
  it('clean() returns null', async () => {
    const cleaner = new NullContextCleaner();
    const result = await cleaner.clean({
      agent_id: 'agent_test',
      source_task_id: 'task_test',
      raw_context: 'test context',
      driver_returns: [],
    });
    expect(result).toBeNull();
  });
});

describe('runTaskMemoryCycle with NullContextCleaner', () => {
  it('buffer 写入正常且 agentContext 为 undefined', async () => {
    const repository = new InMemoryRepository();
    const bufferRepository = new InMemoryBufferRepository();
    const role_id = 'role_ctx_cleaner_test';

    await repository.initializeAgent({ role_id, name: 'Test Agent', tags: [] });
    await bufferRepository.ensureAgent(role_id);

    const memory = createAgentMemoryScope(repository, bufferRepository, role_id);

    const deps: AgentRunDeps = {
      queryMemory: async () => ({ experiences: [], skills: [] }),
      planTaskInstruction: async () => 'Execute the task.',
      invokeDriver: async () => ({
        summary: 'Driver completed task successfully.',
        artifacts: [],
        decisions: [],
        blockers: [],
        referenced_experiences: [],
        assumptions: [],
      }),
      extractor: {
        extract: async (snapshot, _agentContext) => ({
          experiences: [
            {
              id: 'exp_test',
              description: 'Test experience',
              description_embedding: [0.1],
              content: 'Test content',
              confidence: 0.8,
              tags: ['test'],
              agent_id: role_id,
              confidence_history: [],
              referenced_count: 0,
              source_task_id: snapshot.task_id,
              source_driver: snapshot.source_driver,
              type: 'positive',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ],
          result: {
            experiences_created: 1,
            experiences_updated: 0,
            negative_experiences: 0,
            skills_promoted: 0,
          },
        }),
      },
      promote: async () => ({
        check: { eligible: false, auto_approved: false, reasons: [], blocking_rules: [] },
      }),
      contextCleaner: new NullContextCleaner(),
    };

    const task: AgentTaskRequest = {
      spec: 'Test task with NullContextCleaner',
      task_id: 'task_ctx_001',
      call_id: 'call_ctx_001',
      source_driver: 'mock-driver',
    };

    const result = await runTaskMemoryCycle(memory, task, deps);

    expect(result.buffer_snapshot.task_id).toBe('task_ctx_001');
    expect(result.extraction.experiences).toHaveLength(1);

    // processPendingBuffer 已消费该 buffer，pending 应已清空
    const pending = await memory.getPendingBuffer(result.buffer_seq);
    expect(pending).toBeUndefined();
  });
});
