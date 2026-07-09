/**
 * AlwaysExtractPolicy — 总是触发提取的 BufferTriggerPolicy
 *
 * 用于手动模式：无论 buffer 状态如何，shouldExtract 始终返回 true。
 * 配合 ExperienceExtractorProcessor.extractAll() 使用。
 */
import type { BufferMeta, BufferSnapshot } from '../schemas';
import type { BufferTriggerPolicy } from '../ports/buffer-trigger-policy';

export class AlwaysExtractPolicy implements BufferTriggerPolicy {
  shouldExtract(_meta: BufferMeta, _pending: BufferSnapshot[]): boolean {
    return true;
  }
}
