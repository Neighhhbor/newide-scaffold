/**
 * ================================================
 * Built-in Memory Tools (LiteLLM-compatible)
 * ================================================
 * Pre-built tools for memory operations.
 * Extend BaseTool from litellm for type-safe, self-contained tool definitions.
 *
 * These live in the memory module (not litellm) because memory is a
 * domain concept owned by the memory subsystem — litellm only provides
 * the tool interface contract.
 */

import { BaseTool, objectParam, stringParam, numberParam } from '../litellm/tools/tool-interface';
import type { MemoryStore, MemoryEntry } from './types';

/** Tool: Query memory store for relevant entries */
export class QueryMemoryTool extends BaseTool {
  readonly name = 'query_memory';
  readonly description = 'Search the memory store for relevant past experiences, skills, or facts';
  readonly parameters = objectParam(
    {
      query: stringParam('Search query describing what to look for'),
      limit: numberParam('Maximum number of entries to retrieve (default: 5)'),
      type: {
        type: 'string',
        description: 'Filter by memory type: experience, skill, fact, or context',
      },
    },
    ['query'],
  );

  constructor(private readonly store: MemoryStore) {
    super();
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const query = String(args.query);
    const limit = typeof args.limit === 'number' ? args.limit : 5;
    const type = args.type as string | undefined;

    const results = await this.store.search(query, limit);

    const filtered = type ? results.filter((r) => r.type === type) : results;

    return JSON.stringify({
      count: filtered.length,
      memories: filtered.map((r) => ({
        id: r.id,
        type: r.type,
        content: r.content,
        importance: r.importance ?? 0.5,
      })),
    });
  }
}

/** Tool: Save a memory entry */
export class SaveMemoryTool extends BaseTool {
  readonly name = 'save_memory';
  readonly description = 'Save a new memory entry to the store';
  readonly parameters = objectParam(
    {
      content: stringParam('The memory content to save'),
      type: {
        type: 'string',
        enum: ['experience', 'skill', 'fact', 'context'],
        description: 'Type of memory',
      },
      importance: numberParam('Importance score 0-1 (default: 0.5)'),
      tags: { type: 'string', description: 'Comma-separated tags' },
    },
    ['content', 'type'],
  );

  constructor(private readonly store: MemoryStore) {
    super();
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const entry: MemoryEntry = {
      id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: (args.type as MemoryEntry['type']) ?? 'fact',
      content: String(args.content),
      importance: typeof args.importance === 'number' ? args.importance : 0.5,
      tags: args.tags
        ? String(args.tags)
            .split(',')
            .map((t) => t.trim())
        : [],
      timestamp: new Date().toISOString(),
    };

    await this.store.save(entry);
    return JSON.stringify({ saved: true, id: entry.id });
  }
}

/** Create all memory tools for a given store */
export function createMemoryTools(store: MemoryStore): BaseTool[] {
  return [new QueryMemoryTool(store), new SaveMemoryTool(store)];
}
