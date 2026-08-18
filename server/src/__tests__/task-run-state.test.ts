import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertTaskRunTransition,
  canTransitionTaskRun,
  InvalidTaskRunTransitionError,
  isTaskRunStatus,
  isTerminalTaskRunStatus,
  TASK_RUN_STATUSES,
  TASK_RUN_TRANSITIONS,
  type TaskRunStatus,
} from '../../../shared/task-run-state.js'

const expectedTransitions: Record<TaskRunStatus, readonly TaskRunStatus[]> = {
  running: ['waiting_user', 'blocked', 'failed_recoverable', 'completed', 'paused', 'cancelled'],
  waiting_user: ['running', 'blocked', 'paused', 'cancelled'],
  blocked: ['running', 'waiting_user', 'failed_recoverable', 'paused', 'cancelled'],
  failed_recoverable: ['running', 'cancelled'],
  completed: [],
  paused: ['running', 'waiting_user', 'blocked', 'cancelled'],
  cancelled: [],
}

test('Task Run statuses have an explicit transition list', () => {
  assert.deepEqual(Object.keys(TASK_RUN_TRANSITIONS).sort(), [...TASK_RUN_STATUSES].sort())
  assert.deepEqual(TASK_RUN_TRANSITIONS, expectedTransitions)
})

test('canTransitionTaskRun accepts exactly the declared transition matrix', () => {
  for (const from of TASK_RUN_STATUSES) {
    for (const to of TASK_RUN_STATUSES) {
      assert.equal(
        canTransitionTaskRun(from, to),
        expectedTransitions[from].includes(to),
        `${from} -> ${to}`,
      )
    }
  }
})

test('terminal Task Run states cannot transition', () => {
  for (const terminal of ['completed', 'cancelled'] as const) {
    assert.equal(isTerminalTaskRunStatus(terminal), true)
    for (const to of TASK_RUN_STATUSES) assert.equal(canTransitionTaskRun(terminal, to), false)
  }

  assert.equal(isTerminalTaskRunStatus('failed_recoverable'), false)
})

test('a recoverable failure resumes as a new running attempt or is cancelled', () => {
  assert.equal(canTransitionTaskRun('failed_recoverable', 'running'), true)
  assert.equal(canTransitionTaskRun('failed_recoverable', 'cancelled'), true)
  assert.equal(canTransitionTaskRun('failed_recoverable', 'completed'), false)
  assert.equal(canTransitionTaskRun('failed_recoverable', 'paused'), false)
})

test('paused runs resume only to pausable responsibility states', () => {
  assert.equal(canTransitionTaskRun('paused', 'running'), true)
  assert.equal(canTransitionTaskRun('paused', 'waiting_user'), true)
  assert.equal(canTransitionTaskRun('paused', 'blocked'), true)
  assert.equal(canTransitionTaskRun('paused', 'failed_recoverable'), false)
  assert.equal(canTransitionTaskRun('paused', 'completed'), false)
})

test('assertTaskRunTransition reports both ends of an invalid transition', () => {
  assert.doesNotThrow(() => assertTaskRunTransition('running', 'waiting_user'))

  assert.throws(
    () => assertTaskRunTransition('completed', 'running'),
    (error: unknown) => {
      assert.ok(error instanceof InvalidTaskRunTransitionError)
      assert.equal(error.code, 'INVALID_TASK_RUN_TRANSITION')
      assert.equal(error.from, 'completed')
      assert.equal(error.to, 'running')
      return true
    },
  )
})

test('isTaskRunStatus rejects unknown and non-string values', () => {
  for (const status of TASK_RUN_STATUSES) assert.equal(isTaskRunStatus(status), true)
  for (const value of ['default', 'failed', 'COMPLETED', '', null, undefined, 1, {}]) {
    assert.equal(isTaskRunStatus(value), false)
  }
})
