/**
 * ================================================
 * Method Registry
 * ================================================
 * Central registry for all callable method handlers.
 * Methods are registered by name and can be looked up at runtime.
 */

import type { MethodHandler, MethodName } from '../contract';

export class MethodRegistry {
  private readonly methods = new Map<MethodName, MethodHandler>();

  /** Register a method */
  register(handler: MethodHandler): void {
    if (this.methods.has(handler.name)) {
      throw new Error(`Method "${handler.name}" is already registered`);
    }
    this.methods.set(handler.name, handler);
  }

  /** Register multiple methods */
  registerAll(handlers: MethodHandler[]): void {
    for (const h of handlers) {
      this.register(h);
    }
  }

  /** Look up a method by name */
  get(name: MethodName): MethodHandler | undefined {
    return this.methods.get(name);
  }

  /** Check if a method exists */
  has(name: MethodName): boolean {
    return this.methods.has(name);
  }

  /** Remove a method */
  unregister(name: MethodName): boolean {
    return this.methods.delete(name);
  }

  /** Get all registered method names */
  list(): MethodName[] {
    return Array.from(this.methods.keys());
  }

  /** Get all handlers */
  getAll(): MethodHandler[] {
    return Array.from(this.methods.values());
  }

  /** Get methods filtered by task type */
  findByTask(task: string): MethodHandler[] {
    return this.getAll().filter((m) => m.task === task);
  }

  /** Clear all registrations */
  clear(): void {
    this.methods.clear();
  }
}
