/**
 * Coordinator Task 状态机 MVP。
 *
 * - 覆盖当前 mock coordinator 对外暴露的 TaskStatus 集合。
 * - 只负责校验状态能否从 current 推进到 next，不负责持久化、事件、Gate/Council 调用。
 * - terminal 状态 completed / failed / cancelled 一旦进入，不允许再回到运行态。
 *
 * 这里是 coordinator 控制面的基础约束：上层 facade / contract 只能通过这个状态机推进任务，
 * 避免 demo 或后续 mock 直接把 task.status 当普通字符串随意改写。
 */
export type CoordinatorTaskStatus =
  | 'created'
  | 'claimed'
  | 'running'
  | 'waiting_input'
  | 'pending_gate'
  | 'pending_council'
  | 'reviewing'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface TaskStatusTransition {
  previous_status: CoordinatorTaskStatus;
  next_status: CoordinatorTaskStatus;
}

const TERMINAL_TASK_STATUSES = new Set<CoordinatorTaskStatus>(['completed', 'failed', 'cancelled']);

const NON_TERMINAL_TASK_STATUSES: readonly CoordinatorTaskStatus[] = [
  'created',
  'claimed',
  'running',
  'waiting_input',
  'pending_gate',
  'pending_council',
  'reviewing',
  'blocked',
];

const ALLOWED_TRANSITIONS: Readonly<
  Record<CoordinatorTaskStatus, readonly CoordinatorTaskStatus[]>
> = {
  created: ['claimed', 'cancelled'],
  claimed: ['running', 'cancelled'],
  running: ['reviewing', 'waiting_input', 'pending_gate', 'pending_council', 'failed', 'cancelled'],
  waiting_input: ['running', 'cancelled'],
  pending_gate: ['running', 'blocked', 'cancelled'],
  pending_council: ['reviewing', 'waiting_input', 'blocked', 'cancelled'],
  reviewing: ['completed', 'blocked', 'cancelled'],
  blocked: ['running', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

export function transitionTaskStatus(
  current: CoordinatorTaskStatus,
  next: CoordinatorTaskStatus,
): TaskStatusTransition {
  assertTaskStatusTransition(current, next);

  return {
    previous_status: current,
    next_status: next,
  };
}

export function assertTaskStatusTransition(
  current: CoordinatorTaskStatus,
  next: CoordinatorTaskStatus,
): void {
  if (current === next) {
    return;
  }

  const allowedNextStatuses = ALLOWED_TRANSITIONS[current];
  if (!allowedNextStatuses.includes(next)) {
    throw new Error(`Invalid task status transition: ${current} -> ${next}`);
  }
}

export function isTerminalTaskStatus(status: CoordinatorTaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.has(status);
}

export function listNonTerminalTaskStatuses(): readonly CoordinatorTaskStatus[] {
  return NON_TERMINAL_TASK_STATUSES;
}
