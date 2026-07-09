/**
 * ================================================
 * Method Interface
 * ================================================
 * Base classes and interfaces for extensible method handlers.
 */

import type {
  MethodHandler,
  MethodContext,
  MethodResult,
  MethodName,
  LiteLLMTaskType,
  Tool,
  LiteLLMMessage,
  CompletionRequest,
} from './types';

/** Abstract base class for method handlers */
export abstract class BaseMethod implements MethodHandler {
  abstract readonly name: MethodName;
  abstract readonly description: string;
  abstract readonly task: LiteLLMTaskType;
  readonly defaultTools?: Tool[];

  abstract execute(
    context: MethodContext,
    params: Record<string, unknown>,
  ): Promise<MethodResult> | MethodResult;

  /** Helper: build a standard completion request */
  protected buildRequest(
    messages: LiteLLMMessage[],
    tools?: Tool[],
    overrides?: Partial<CompletionRequest>,
  ): CompletionRequest {
    return {
      task: this.task,
      messages,
      tools,
      ...overrides,
    };
  }

  /** Helper: create a successful result */
  protected ok(content: string, data?: Record<string, unknown>): MethodResult {
    return { content, data };
  }
}

/** Method that uses tool-calling loop */
export abstract class ToolCallingMethod extends BaseMethod {
  /** Override to provide tool schemas */
  abstract getToolSchemas(): Tool[];

  /** Override to provide tool handlers */
  abstract getToolHandlers(): Record<
    string,
    (args: Record<string, unknown>) => Promise<string> | string
  >;

  async executeWithTools(
    context: MethodContext,
    messages: LiteLLMMessage[],
    maxRounds = 10,
  ): Promise<MethodResult> {
    const tools = this.getToolSchemas();
    const handlers = this.getToolHandlers();

    // Merge with context tools
    const allHandlers = { ...context.tools, ...handlers };

    const response = await context.completeWithTools(
      this.buildRequest(messages, tools),
      allHandlers,
      maxRounds,
    );

    return {
      content: response.content,
      usage: response.usage,
    };
  }
}

/** Method that uses structured output */
export abstract class StructuredMethod extends BaseMethod {
  abstract getOutputSchema(): {
    name: string;
    schema: Record<string, unknown>;
  };

  async executeStructured<T = Record<string, unknown>>(
    context: MethodContext,
    messages: LiteLLMMessage[],
  ): Promise<T> {
    const schema = this.getOutputSchema();
    return context.structured<T>({
      ...this.buildRequest(messages),
      responseFormat: {
        name: schema.name,
        schema: schema.schema,
        strict: true,
      },
    });
  }
}
