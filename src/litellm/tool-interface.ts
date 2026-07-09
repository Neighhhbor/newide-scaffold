/**
 * ================================================
 * Tool Interface
 * ================================================
 * Extensible tool definitions using class-based approach.
 * Each tool is self-contained with schema + handler.
 */

import type { Tool, ToolHandler } from './types';

/** A tool that can be registered and invoked */
export abstract class BaseTool {
  /** Unique tool name */
  abstract readonly name: string;
  /** Tool description for LLM */
  abstract readonly description: string;
  /** JSON Schema for parameters */
  abstract readonly parameters: Record<string, unknown>;

  /** Execute the tool */
  abstract execute(args: Record<string, unknown>): Promise<string> | string;

  /** Get the OpenAI-compatible tool schema */
  toSchema(): Tool {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: this.parameters,
      },
    };
  }

  /** Get the handler function */
  toHandler(): ToolHandler {
    return (args) => this.execute(args);
  }
}

/** Factory for creating simple tools without classes */
export function createTool(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  handler: ToolHandler,
): { schema: Tool; handler: ToolHandler; name: string } {
  return {
    name,
    schema: {
      type: 'function',
      function: { name, description, parameters },
    },
    handler,
  };
}

/** Helper: build a simple object parameter schema */
export function objectParam(
  properties: Record<string, ParamDescriptor>,
  required?: string[],
): Record<string, unknown> {
  return {
    type: 'object',
    properties: Object.fromEntries(
      Object.entries(properties).map(([k, v]) => [k, { type: v.type, description: v.description }]),
    ),
    required: required ?? Object.keys(properties),
  };
}

/** Helper: build a string parameter schema */
export function stringParam(description: string): { type: string; description: string } {
  return { type: 'string', description };
}

/** Helper: build a number parameter schema */
export function numberParam(description: string): { type: string; description: string } {
  return { type: 'number', description };
}

/** Helper: build an enum parameter schema */
export function enumParam(
  values: string[],
  description: string,
): { type: string; enum: string[]; description: string } {
  return { type: 'string', enum: values, description };
}

/** Parameter property descriptor accepted by objectParam */
export type ParamDescriptor =
  | { type: string; description: string }
  | { type: string; enum: string[]; description: string };
