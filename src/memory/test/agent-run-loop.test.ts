/**
 * Agent run loop 语义测试
 *
 * 验证目标态持久 run loop 目前只是占位；实际 MVP 执行链路仍由 runOnce 承担。
 */
import { describe, expect, it } from 'vitest';
import { Agent } from '../runtime/agent';
import { createAgentMemoryScope } from '../adapters/agent-memory-scope';
import { InMemoryRepository } from '../adapters/in-memory-repository';
import { InMemoryBufferRepository } from '../adapters/in-memory-buffer-repository';

describe('Agent run loop placeholder', () => {
  it('startLoop only enters sleeping and runLoopTick reports skipped', async () => {
    const repository = new InMemoryRepository();
    const bufferRepository = new InMemoryBufferRepository();
    const role_id = 'role_loop_placeholder';

    await repository.initializeAgent({ role_id, name: 'Loop Placeholder Agent' });
    await bufferRepository.ensureAgent(role_id);

    const memory = createAgentMemoryScope(repository, bufferRepository, role_id);
    const agent = new Agent(memory);

    agent.startLoop();
    expect(agent.getState()).toBe('sleeping');

    const tick = await agent.runLoopTick();
    expect(tick.status).toBe('skipped');
    expect(tick.reason).toContain('runOnce is the MVP synchronous path');
    expect(agent.getState()).toBe('sleeping');
  });
});
