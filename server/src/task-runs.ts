import {
  assertTaskRunTransition,
  type TaskRunStatus,
} from '../../shared/task-run-state.js'

export const TASK_RUN_ACTIONS = [
  'pause',
  'resume',
  'cancel',
  'approve',
  'retry',
  'wait_user',
  'block',
  'unblock',
  'fail',
  'complete',
] as const

export type TaskRunAction = (typeof TASK_RUN_ACTIONS)[number]

const TASK_RUN_ACTION_SET: ReadonlySet<string> = new Set(TASK_RUN_ACTIONS)

export function isTaskRunAction(value: unknown): value is TaskRunAction {
  return typeof value === 'string' && TASK_RUN_ACTION_SET.has(value)
}

export interface TaskRunActionPlan {
  toStatus: TaskRunStatus
  pausedFromStatus: TaskRunStatus | null
  finishAttemptAs: 'failed' | 'completed' | 'cancelled' | null
  startsNewAttempt: boolean
}

/** Resolve the persisted effects of an action before any SQL is issued.
 * The shared transition matrix remains the single authority for legality. */
export function planTaskRunAction(
  action: TaskRunAction,
  fromStatus: TaskRunStatus,
  pausedFromStatus: TaskRunStatus | null,
): TaskRunActionPlan {
  let toStatus: TaskRunStatus
  let nextPausedFrom: TaskRunStatus | null = null
  let finishAttemptAs: TaskRunActionPlan['finishAttemptAs'] = null
  let startsNewAttempt = false

  switch (action) {
    case 'pause':
      toStatus = 'paused'
      nextPausedFrom = fromStatus
      break
    case 'resume':
      if (fromStatus !== 'paused' || !pausedFromStatus) {
        throw new Error('paused Task Run is missing its prior status')
      }
      toStatus = pausedFromStatus
      break
    case 'cancel':
      toStatus = 'cancelled'
      finishAttemptAs = 'cancelled'
      break
    case 'approve':
      toStatus = 'running'
      break
    case 'retry':
      toStatus = 'running'
      startsNewAttempt = true
      break
    case 'wait_user':
      toStatus = 'waiting_user'
      break
    case 'block':
      toStatus = 'blocked'
      break
    case 'unblock':
      toStatus = 'running'
      break
    case 'fail':
      toStatus = 'failed_recoverable'
      finishAttemptAs = 'failed'
      break
    case 'complete':
      toStatus = 'completed'
      finishAttemptAs = 'completed'
      break
  }

  assertTaskRunTransition(fromStatus, toStatus)
  return { toStatus, pausedFromStatus: nextPausedFrom, finishAttemptAs, startsNewAttempt }
}
