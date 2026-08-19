import assert from 'node:assert/strict'
import test from 'node:test'
import {
  mergeTaskRunCache,
  mergeTaskRunConversationCache,
  mergeTaskRunDetailCache,
  type TaskRunCacheEntry,
  TrailingRefreshQueue,
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

test('an overlapping recovery refresh produces one trailing request', async () => {
  const queue = new TrailingRefreshQueue<number>()
  let releaseFirst: (() => void) | undefined
  const firstResponse = new Promise<void>((resolve) => { releaseFirst = resolve })
  let calls = 0
  const request = async () => {
    calls += 1
    if (calls === 1) await firstResponse
  }

  const initial = queue.run(1, request, () => true)
  const hello = queue.run(1, request, () => true)
  const duplicateHello = queue.run(1, request, () => true)
  assert.equal(calls, 1)
  releaseFirst?.()
  await Promise.all([initial, hello, duplicateHello])

  assert.equal(calls, 2)
})

test('late action detail cannot replace a newer websocket detail', () => {
  const newest = run('run1', 3, 'paused')
  const staleAction = run('run1', 2, 'waiting_user')

  const merged = mergeTaskRunDetailCache({ run1: newest }, staleAction, newest.revision)

  assert.equal(merged.run1.revision, 3)
  assert.equal(merged.run1.status, 'paused')
})
