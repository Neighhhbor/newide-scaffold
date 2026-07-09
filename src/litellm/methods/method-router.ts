/**
 * ================================================
 * Method Router
 * ================================================
 * Routes method calls to registered handlers.
 * Provides the MethodContext for handler execution.
 */

import { MethodRegistry } from './method-registry';
import type { MethodHandler, MethodName, MethodContext, MethodResult } from '../contract';

export class MethodRouter {
  readonly registry = new MethodRegistry();

  constructor(private readonly createContext: () => MethodContext) {}

  /** Route a call to the appropriate method */
  async call(name: MethodName, params: Record<string, unknown> = {}): Promise<MethodResult> {
    const handler = this.registry.get(name);
    if (!handler) {
      throw new Error(
        `Method "${name}" not found. Available: [${this.registry.list().join(', ')}]`,
      );
    }

    const context = this.createContext();
    return handler.execute(context, params);
  }

  /** Check if a method is available */
  canCall(name: MethodName): boolean {
    return this.registry.has(name);
  }

  /** Get handler metadata */
  describe(name: MethodName): Pick<MethodHandler, 'name' | 'description' | 'task'> | undefined {
    const handler = this.registry.get(name);
    if (!handler) return undefined;
    return {
      name: handler.name,
      description: handler.description,
      task: handler.task,
    };
  }

  /** List all available methods with descriptions */
  list(): Array<{ name: string; description: string; task: string }> {
    return this.registry.getAll().map((h) => ({
      name: h.name,
      description: h.description,
      task: h.task,
    }));
  }
}
