import assert from 'node:assert/strict'
import test from 'node:test'
import { ChatTaskRunError, parseChatTaskRunDraft } from '../chat-task-run.js'

test('ordinary chat messages do not create a Task Run draft', () => {
  assert.equal(parseChatTaskRunDraft(undefined, 'hello'), null)
})

test('chat Task Run defaults its title to the source message', () => {
  assert.deepEqual(parseChatTaskRunDraft({ assigneeId: 'bram-1' }, '  ship the report  '), {
    assigneeId: 'bram-1',
    title: 'ship the report',
    summary: '',
    consequence: '',
    metadata: {},
  })
})

test('chat Task Run requires a concrete assignee', () => {
  assert.throws(
    () => parseChatTaskRunDraft({}, 'ship the report'),
    (error) => error instanceof ChatTaskRunError && error.message === 'taskRun.assigneeId required',
  )
})

test('chat Task Run accepts explicit context and preserves caller metadata', () => {
  assert.deepEqual(parseChatTaskRunDraft({
    assigneeId: 'bram-1',
    title: 'Ship report',
    summary: 'Prepare the final report',
    consequence: 'Customer cannot review without it',
    metadata: { source: 'composer' },
  }, 'please ship'), {
    assigneeId: 'bram-1',
    title: 'Ship report',
    summary: 'Prepare the final report',
    consequence: 'Customer cannot review without it',
    metadata: { source: 'composer' },
  })
})
