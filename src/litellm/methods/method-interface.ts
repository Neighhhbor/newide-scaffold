/**
 * ================================================
 * Method Interface
 * ================================================
 * A single base class for all method handlers.
 *
 * Tools are declared as instances — schemas + handlers auto-extracted.
 * Everything else happens in `execute()` via the MethodContext:
 *
 *   context.complete(request)           — basic completion
 *   context.completeWithTools(req, h, n) — tool-calling loop
 *   context.structured<T>(request)      — typed JSON output
 *   context.stream(request)             — streaming
 *
 * Combine freely — no artificial separation.
 */

import type {
  MethodHandler,
  MethodContext,
  MethodResult,
  MethodName,
  LiteLLMTaskType,
  Tool,
  ToolHandler,
  LiteLLMMessage,
  CompletionRequest,
} from '../contract';
import type { BaseTool } from '../tools/tool-interface';

export abstract class BaseMethod implements MethodHandler {
  abstract readonly name: MethodName;
  abstract readonly description: string;
  abstract readonly task: LiteLLMTaskType;

  /** Preferred model profile — e.g. "cheap", "balanced". */
  readonly defaultProfile?: string;

  /** Tools this method uses. Schemas + handlers are auto-extracted. */
  readonly tools: BaseTool[] = [];

  abstract execute(
    context: MethodContext,
    params: Record<string, unknown>,
  ): Promise<MethodResult> | MethodResult;

  /** Auto-extract tool schemas from `this.tools`. */
  getToolSchemas(): Tool[] {
    return this.tools.map((t) => t.toSchema());
  }

  /** Auto-extract tool handlers from `this.tools`, keyed by tool name. */
  getToolHandlers(): Record<string, ToolHandler> {
    const handlers: Record<string, ToolHandler> = {};
    for (const t of this.tools) {
      handlers[t.name] = t.toHandler();
    }
    return handlers;
  }

  /** Build a completion request with this method's task and the given messages. */
  protected buildRequest(
    messages: LiteLLMMessage[],
    overrides?: Partial<CompletionRequest>,
  ): CompletionRequest {
    return {
      task: this.task,
      messages,
      tools: this.tools.length > 0 ? this.getToolSchemas() : undefined,
      ...overrides,
    };
  }

  /** Shorthand for returning a successful result. */
  protected ok(content: string, data?: Record<string, unknown>): MethodResult {
    return { content, data };
  }
}
