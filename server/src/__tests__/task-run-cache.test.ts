import assert from 'node:assert/strict'
import test from 'node:test'
import {
  mergeTaskRunCache,
  mergeTaskRunConversationCache,
  type TaskRunCacheEntry,
} from '../../../src/stores/task-run-cache.js'

type Run = TaskRunCacheEntry & {
  conversationId: string | null
  status: string
}

function run(id: string, revision: number, status: string): Run {
  return {
    id,
    revision,
    status,
    conversationId: 'conversation-1',
    updatedAt: new Date(revision * 1_000).toISOString(),
  }
}

test('late REST and duplicate snapshots cannot lower a Task Run revision', () => {
  const current = { run1: run('run1', 2, 'waiting_user') }
  const stale = run('run1', 1, 'running')

  const merged = mergeTaskRunCache(current, [stale, stale])

  assert.equal(Object.keys(merged).length, 1)
  assert.equal(merged.run1.revision, 2)
  assert.equal(merged.run1.status, 'waiting_user')
})

test('a scoped REST response cannot delete a Run that arrived over WS after request start', () => {
  const idsAtRequestStart = new Set(['run1'])
  const afterWs = {
    run1: run('run1', 2, 'waiting_user'),
    run2: run('run2', 1, 'running'),
  }

  const merged = mergeTaskRunConversationCache(
    afterWs,
    [run('run1', 1, 'running')],
    'conversation-1',
    idsAtRequestStart,
  )

  assert.deepEqual(Object.keys(merged).sort(), ['run1', 'run2'])
  assert.equal(merged.run1.revision, 2)
  assert.equal(merged.run2.revision, 1)
})
