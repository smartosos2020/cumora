/**
 * Lifecycle states for one execution of a chat instruction.
 *
 * A Task Run is deliberately separate from a Boards card. The values are kept
 * in a shared module so the API and every client render the same state machine.
 */
export const TASK_RUN_STATUSES = [
  'running',
  'waiting_user',
  'blocked',
  'failed_recoverable',
  'completed',
  'paused',
  'cancelled',
] as const

export type TaskRunStatus = (typeof TASK_RUN_STATUSES)[number]

export const TASK_RUN_TERMINAL_STATUSES = ['completed', 'cancelled'] as const satisfies readonly TaskRunStatus[]
export type TaskRunTerminalStatus = (typeof TASK_RUN_TERMINAL_STATUSES)[number]

export const TASK_RUN_PAUSABLE_STATUSES = ['running', 'waiting_user', 'blocked'] as const satisfies readonly TaskRunStatus[]
export type TaskRunPausableStatus = (typeof TASK_RUN_PAUSABLE_STATUSES)[number]

/**
 * Allowed persisted state changes.
 *
 * `paused` may resume only to a state that can itself be paused. Persistence
 * must retain which of those states was paused so a resume cannot change the
 * next responsible party. `failed_recoverable -> running` starts a new attempt.
 */
export const TASK_RUN_TRANSITIONS = {
  running: ['waiting_user', 'blocked', 'failed_recoverable', 'completed', 'paused', 'cancelled'],
  waiting_user: ['running', 'blocked', 'paused', 'cancelled'],
  blocked: ['running', 'waiting_user', 'failed_recoverable', 'paused', 'cancelled'],
  failed_recoverable: ['running', 'cancelled'],
  completed: [],
  paused: ['running', 'waiting_user', 'blocked', 'cancelled'],
  cancelled: [],
} as const satisfies Record<TaskRunStatus, readonly TaskRunStatus[]>

const TASK_RUN_STATUS_SET: ReadonlySet<string> = new Set(TASK_RUN_STATUSES)
const TASK_RUN_TERMINAL_STATUS_SET: ReadonlySet<TaskRunStatus> = new Set(TASK_RUN_TERMINAL_STATUSES)

export function isTaskRunStatus(value: unknown): value is TaskRunStatus {
  return typeof value === 'string' && TASK_RUN_STATUS_SET.has(value)
}

export function isTerminalTaskRunStatus(status: TaskRunStatus): status is TaskRunTerminalStatus {
  return TASK_RUN_TERMINAL_STATUS_SET.has(status)
}

export function canTransitionTaskRun(from: TaskRunStatus, to: TaskRunStatus): boolean {
  return (TASK_RUN_TRANSITIONS[from] as readonly TaskRunStatus[]).includes(to)
}

export class InvalidTaskRunTransitionError extends Error {
  readonly code = 'INVALID_TASK_RUN_TRANSITION'

  constructor(
    readonly from: TaskRunStatus,
    readonly to: TaskRunStatus,
  ) {
    super(`Invalid Task Run transition: ${from} -> ${to}`)
    this.name = 'InvalidTaskRunTransitionError'
  }
}

export function assertTaskRunTransition(from: TaskRunStatus, to: TaskRunStatus): void {
  if (!canTransitionTaskRun(from, to)) throw new InvalidTaskRunTransitionError(from, to)
}
