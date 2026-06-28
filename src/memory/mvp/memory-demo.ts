/**
 * Memory MVP 端到端演示脚本
 *
 * 演示 createAgent → submitTask → buffer → 提取 → 晋升；运行：npx tsx src/memory/mvp/memory-demo.ts
 */
import { AgentManager } from '../runtime/agent-manager';
import { InMemoryRepository } from '../adapters/in-memory-repository';
import { InMemoryBufferRepository } from '../adapters/in-memory-buffer-repository';

async function main(): Promise<void> {
  const repository = new InMemoryRepository();
  const bufferRepository = new InMemoryBufferRepository();
  const manager = AgentManager.create(repository, bufferRepository);

  console.log('=== 1. 创建 Agent ===');
  const handle = await manager.createAgent({
    role_id: 'role_ts_engineer',
    name: 'TypeScript Engineer',
    persona_seed: 'Senior TS engineer for scaffold demos.',
    tags: ['typescript', 'architecture'],
  });
  console.log(`  created: ${handle.role_id} (${handle.name})`);

  console.log('\n=== 2. 启动并派发任务（含 skill 晋升 mock）===');
  manager.start();
  const task_id = 'task_demo_001';
  const { winner_role_id, cycle } = await manager.submitTask({
    spec: 'Demonstrate full memory MVP cycle.',
    task_id,
    call_id: 'call_demo_001',
    scenario: 'promotion_ready',
  });
  console.log(`  winner: ${winner_role_id}`);
  console.log(`  context: ${cycle.extraction.experiences.length} experience(s) extracted`);
  console.log(
    `  promotion: ${cycle.promotion.skill ? cycle.promotion.skill.description : 'skipped'}`,
  );

  console.log('\n=== 3. 验证 repository 状态 ===');
  const experiences = await repository.listExperiences('role_ts_engineer');
  const skills = await repository.listSkills('role_ts_engineer');
  const meta = await bufferRepository.getBufferMeta('role_ts_engineer');
  console.log(`  experiences: ${experiences.length}, skills: ${skills.length}`);
  console.log(`  buffer processed: ${meta.total_processed}, pending: ${meta.pending_count}`);

  console.log('\n=== done ===');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
