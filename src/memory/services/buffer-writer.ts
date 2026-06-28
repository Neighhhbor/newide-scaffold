/**
 * writePendingBuffer — 缓冲区写入服务
 *
 * 校验 BufferSnapshot 后，通过 AgentMemoryScope 写入 pending buffer；
 * 可配对 AgentContextSnapshot。仅使用 Spec 类型，不含 mock 映射逻辑。
 */
import { BufferSnapshotSchema, type BufferSnapshot, type AgentContextSnapshot } from '../schemas';
import type { AgentMemoryScope } from '../ports/agent-memory-scope';
import type { SaveBufferResult } from '../ports/buffer-repository';

export async function writePendingBuffer(
  memory: AgentMemoryScope,
  snapshot: BufferSnapshot,
  agentContext?: AgentContextSnapshot,
): Promise<SaveBufferResult> {
  BufferSnapshotSchema.parse(snapshot);
  return memory.saveBufferSnapshot(snapshot, agentContext);
}
