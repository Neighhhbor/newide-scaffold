/**
 * ================================================
 * Tool Registry
 * ================================================
 * Central registry for tools.
 * Supports both BaseTool instances and ad-hoc tool definitions.
 */

import type { Tool, ToolHandler } from './types';
import type { BaseTool} from './tool-interface';
import { createTool } from './tool-interface';

export class ToolRegistry {
  private readonly schemas = new Map<string, Tool>();
  private readonly handlers = new Map<string, ToolHandler>();

  /** Register a BaseTool instance */
  register(tool: BaseTool): void {
    this.schemas.set(tool.name, tool.toSchema());
    this.handlers.set(tool.name, tool.toHandler());
  }

  /** Register multiple BaseTool instances */
  registerAll(tools: BaseTool[]): void {
    for (const t of tools) this.register(t);
  }

  /** Register an ad-hoc tool */
  registerAdHoc(
    name: string,
    description: string,
    parameters: Record<string, unknown>,
    handler: ToolHandler,
  ): void {
    const tool = createTool(name, description, parameters, handler);
    this.schemas.set(name, tool.schema);
    this.handlers.set(name, tool.handler);
  }

  /** Get tool schema */
  getSchema(name: string): Tool | undefined {
    return this.schemas.get(name);
  }

  /** Get tool handler */
  getHandler(name: string): ToolHandler | undefined {
    return this.handlers.get(name);
  }

  /** Check if a tool exists */
  has(name: string): boolean {
    return this.schemas.has(name);
  }

  /** Remove a tool */
  unregister(name: string): boolean {
    return this.schemas.delete(name) || this.handlers.delete(name);
  }

  /** Get all tool schemas (for passing to LLM) */
  getAllSchemas(): Tool[] {
    return Array.from(this.schemas.values());
  }

  /** Get all handlers (for tool execution) */
  getAllHandlers(): Record<string, ToolHandler> {
    return Object.fromEntries(this.handlers.entries());
  }

  /** Get tool names */
  list(): string[] {
    return Array.from(this.schemas.keys());
  }

  /** Merge with another registry */
  merge(other: ToolRegistry): this {
    for (const [name, schema] of other.schemas) {
      this.schemas.set(name, schema);
    }
    for (const [name, handler] of other.handlers) {
      this.handlers.set(name, handler);
    }
    return this;
  }

  /** Clear all tools */
  clear(): void {
    this.schemas.clear();
    this.handlers.clear();
  }
}
