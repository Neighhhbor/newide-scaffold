/**
 * ================================================
 * Methods — Barrel Export
 * ================================================
 * Isolated method subsystem: interface, registry, and router.
 *
 * To add a new method, create a file in this directory
 * extending BaseMethod, then register it:
 *
 *   client.registerMethod(new MyMethod());
 */

export * from './method-interface';
export * from './method-registry';
export * from './method-router';
