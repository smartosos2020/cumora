import assert from 'node:assert/strict'
import test from 'node:test'
import { InvalidTaskRunTransitionError } from '../../../shared/task-run-state.js'
import {
  isTaskRunAction,
  planTaskRunAction,
  TASK_RUN_ACTIONS,
} from '../task-runs.js'

test('Task Run actions are explicit and reject unknown commands', () => {
  for (const action of TASK_RUN_ACTIONS) assert.equal(isTaskRunAction(action), true)
  for (const value of ['restart', 'delete', 'APPROVE', '', null, 1]) {
    assert.equal(isTaskRunAction(value), false)
  }
})

test('pause persists the responsibility state and resume restores it', () => {
  for (const status of ['running', 'waiting_user', 'blocked'] as const) {
    const paused = planTaskRunAction('pause', status, null)
    assert.deepEqual(paused, {
      toStatus: 'paused',
      pausedFromStatus: status,
      finishAttemptAs: null,
      startsNewAttempt: false,
    })

    const resumed = planTaskRunAction('resume', paused.toStatus, paused.pausedFromStatus)
    assert.equal(resumed.toStatus, status)
    assert.equal(resumed.pausedFromStatus, null)
  }
})

test('retry creates a new attempt while approval continues the current attempt', () => {
  const retry = planTaskRunAction('retry', 'failed_recoverable', null)
  assert.equal(retry.toStatus, 'running')
  assert.equal(retry.startsNewAttempt, true)
  assert.equal(retry.finishAttemptAs, null)

  const approve = planTaskRunAction('approve', 'waiting_user', null)
  assert.equal(approve.toStatus, 'running')
  assert.equal(approve.startsNewAttempt, false)
})

test('terminal and failure actions close the current attempt', () => {
  assert.equal(planTaskRunAction('complete', 'running', null).finishAttemptAs, 'completed')
  assert.equal(planTaskRunAction('fail', 'running', null).finishAttemptAs, 'failed')
  assert.equal(planTaskRunAction('cancel', 'blocked', null).finishAttemptAs, 'cancelled')
})

test('actions cannot bypass the shared transition matrix', () => {
  assert.throws(
    () => planTaskRunAction('complete', 'waiting_user', null),
    InvalidTaskRunTransitionError,
  )
  assert.throws(
    () => planTaskRunAction('retry', 'running', null),
    InvalidTaskRunTransitionError,
  )
  assert.throws(
    () => planTaskRunAction('resume', 'paused', null),
    /missing its prior status/,
  )
})
