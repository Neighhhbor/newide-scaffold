export interface MemoryMaintenanceEnqueueRequest {
  role_id: string;
  buffer_seq: number;
  task_id: string;
  run_id: string;
}

export interface MemoryMaintenanceReceipt {
  ref: string;
}

export const MEMORY_MAINTENANCE_STATUSES = ['pending', 'running', 'completed', 'failed'] as const;

export type MemoryMaintenanceStatus = (typeof MEMORY_MAINTENANCE_STATUSES)[number];

export interface MemoryMaintenanceStatusView {
  ref: string;
  status: MemoryMaintenanceStatus;
  updated_at: string;
}

/**
 * Narrow boundary used by the execution facade after a BufferSnapshot is durable.
 * Implementations must persist the receipt before resolving enqueue().
 */
export interface MemoryMaintenanceQueue {
  enqueue(request: MemoryMaintenanceEnqueueRequest): Promise<MemoryMaintenanceReceipt>;
}

/** Read-only status boundary for C/RPC adapters that only hold a receipt ref. */
export interface MemoryMaintenanceStatusQuery {
  getStatus(ref: string): Promise<MemoryMaintenanceStatusView | undefined>;
}
