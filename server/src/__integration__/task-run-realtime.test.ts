import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { after, before, beforeEach, test } from 'node:test'
import WebSocket from 'ws'
import {
  mergeTaskRunCache,
  mergeTaskRunConversationCache,
  type TaskRunCacheEntry,
} from '../../../src/stores/task-run-cache.js'
import { pool } from '../db/pool.js'
import {
  CH_TASK_RUNS,
  sub,
  type TaskRunChangedEvent,
} from '../redis.js'
import { attachWebSocket } from '../ws.js'
import {
  buildApiTestApp,
  ensureSchemaOnce,
  resetAllTables,
  seedUserMembership,
  teardownAll,
} from './_helpers.js'

type TestTaskRun = TaskRunCacheEntry & { status: string; conversationId: string | null }

const ME = 'u-task-run-realtime'
const AGENT = 'a-task-run-realtime'
const COMPANY = 'c-task-run-realtime'
const CONVO = 'co-task-run-realtime'
let server: Server
let baseUrl = ''
const events: TaskRunChangedEvent[] = []

before(async () => {
  await ensureSchemaOnce()
  await sub.subscribe(CH_TASK_RUNS)
  sub.on('message', (channel, payload) => {
    if (channel !== CH_TASK_RUNS) return
    events.push(JSON.parse(payload) as TaskRunChangedEvent)
  })
  const app = await buildApiTestApp(ME)
  await new Promise<void>((resolve) => {
    server = createServer(app)
    attachWebSocket(server)
    server.listen(0, () => {
      const address = server.address()
      if (address && typeof address === 'object') baseUrl = `http://127.0.0.1:${address.port}`
      resolve()
    })
  })
})

beforeEach(async () => {
  events.length = 0
  await resetAllTables()
  await pool.query(
    `INSERT INTO companies (id, name, slug, owner_user_id)
     VALUES ($1, 'Task Run Realtime Co', 'task-run-realtime-co', $2)`,
    [COMPANY, ME],
  )
  await seedUserMembership(ME, COMPANY)
  await pool.query(
    `INSERT INTO participants
      (id, company_id, kind, name, role, initial, avatar_bg, status, system_prompt)
     VALUES ($1, $2, 'agent', 'Runner', 'engineer', 'R', '#abcdef', 'avail', 'test runner')`,
    [AGENT, COMPANY],
  )
  await pool.query(
    `INSERT INTO conversations (id, kind, title, members, tag, company_id)
     VALUES ($1, 'group', 'Task Run Realtime', $2::jsonb, 'group', $3)`,
    [CONVO, JSON.stringify([ME, AGENT]), COMPANY],
  )
})

after(async () => {
  await teardownAll(server)
})

async function waitForEvents(count: number): Promise<void> {
  const deadline = Date.now() + 2_000
  while (events.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(events.length, count)
}

async function openTaskRunSocket(): Promise<{
  socket: WebSocket
  frames: TaskRunChangedEvent[]
}> {
  const ticketResponse = await fetch(`${baseUrl}/api/auth/ws-ticket`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-company-id': COMPANY },
  })
  assert.equal(ticketResponse.status, 200)
  const { ticket } = await ticketResponse.json() as { ticket: string }
  const frames: TaskRunChangedEvent[] = []
  const socket = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/ws?t=${encodeURIComponent(ticket)}`)
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('WebSocket hello timed out')), 2_000)
    socket.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()) as { type: string }
      if (frame.type === 'task-run.changed') frames.push(frame as TaskRunChangedEvent)
      if (frame.type === 'hello') {
        clearTimeout(timeout)
        resolve()
      }
    })
    socket.on('error', reject)
  })
  return { socket, frames }
}

async function waitForFrames(frames: TaskRunChangedEvent[], count: number): Promise<void> {
  const deadline = Date.now() + 2_000
  while (frames.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(frames.length, count)
}

test('[integration] committed Task Run changes reach WebSocket once in revision order; replay stays silent', async () => {
  const { socket, frames } = await openTaskRunSocket()
  const createResponse = await fetch(`${baseUrl}/api/task-runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-company-id': COMPANY },
    body: JSON.stringify({
      title: 'Realtime run',
      conversationId: CONVO,
      assigneeId: AGENT,
    }),
  })
  assert.equal(createResponse.status, 201)
  const created = await createResponse.json() as { id: string; revision: number }
  await waitForEvents(1)

  const actionBody = {
    action: 'wait_user',
    expectedRevision: created.revision,
    idempotencyKey: 'realtime-wait-user-1',
    nextActorId: ME,
    reason: 'Need a decision',
  }
  const actionResponse = await fetch(`${baseUrl}/api/task-runs/${created.id}/actions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-company-id': COMPANY },
    body: JSON.stringify(actionBody),
  })
  assert.equal(actionResponse.status, 200)
  await waitForEvents(2)

  const replayResponse = await fetch(`${baseUrl}/api/task-runs/${created.id}/actions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-company-id': COMPANY },
    body: JSON.stringify(actionBody),
  })
  assert.equal(replayResponse.status, 200)
  const replay = await replayResponse.json() as { idempotentReplay: boolean; revision: number }
  assert.equal(replay.idempotentReplay, true)
  await new Promise((resolve) => setTimeout(resolve, 50))

  const chatResponse = await fetch(`${baseUrl}/api/conversations/${CONVO}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-company-id': COMPANY },
    body: JSON.stringify({
      body: 'Run this from chat',
      taskRun: { assigneeId: AGENT, title: 'Chat realtime run' },
    }),
  })
  assert.equal(chatResponse.status, 202)
  const chat = await chatResponse.json() as { taskRun: { id: string } }
  await waitForEvents(3)
  await waitForFrames(frames, 3)

  const detailResponse = await fetch(`${baseUrl}/api/task-runs/${created.id}`, {
    headers: { 'x-company-id': COMPANY },
  })
  assert.equal(detailResponse.status, 200)
  const detail = await detailResponse.json() as {
    status: string
    revision: number
    events: Array<{ kind: string; revision: number }>
  }
  assert.equal(detail.status, 'waiting_user')
  assert.equal(detail.revision, 2)
  assert.deepEqual(detail.events.map((event) => [event.kind, event.revision]), [
    ['run.created', 1],
    ['action.wait_user', 2],
  ])

  // Feed the real REST snapshots reached from the real WS frames through the
  // exact merge primitive used by the browser Zustand store. Multiple frames
  // for one Run must retain one entity at the highest revision.
  let storeById: Record<string, TestTaskRun> = {}
  for (const frame of frames) {
    const response = await fetch(`${baseUrl}/api/task-runs/${frame.runId}`, {
      headers: { 'x-company-id': COMPANY },
    })
    assert.equal(response.status, 200)
    storeById = mergeTaskRunCache(storeById, [await response.json() as TestTaskRun])
  }
  assert.equal(Object.keys(storeById).length, 2)
  assert.equal(storeById[created.id].revision, 2)
  assert.equal(storeById[created.id].status, 'waiting_user')

  // A late revision-1 REST response and a duplicate revision-1 frame cannot
  // move the already-hydrated revision-2 entity backwards.
  const staleSnapshot: TestTaskRun = {
    ...storeById[created.id],
    revision: 1,
    status: 'running',
    updatedAt: new Date(0).toISOString(),
  }
  storeById = mergeTaskRunCache(storeById, [staleSnapshot, staleSnapshot])
  assert.equal(storeById[created.id].revision, 2)
  assert.equal(storeById[created.id].status, 'waiting_user')

  // Reproduce the scoped-list race: REST starts when only the first Run is in
  // cache; a second Run arrives over WS; the older scoped response omits it.
  // Conversation reconciliation must keep the post-request WS entity and must
  // not downgrade the original entity with its stale revision.
  const idsAtScopedRequestStart = new Set([created.id])
  const chatSnapshot = storeById[chat.taskRun.id]
  const cacheAfterWs = mergeTaskRunCache(
    { [created.id]: storeById[created.id] },
    [chatSnapshot],
  )
  const afterStaleScopedRest = mergeTaskRunConversationCache(
    cacheAfterWs,
    [staleSnapshot],
    CONVO,
    idsAtScopedRequestStart,
  )
  assert.equal(Object.keys(afterStaleScopedRest).length, 2)
  assert.equal(afterStaleScopedRest[created.id].revision, 2)
  assert.equal(afterStaleScopedRest[chat.taskRun.id].revision, 1)

  assert.deepEqual(events.map((event) => ({
    type: event.type,
    companyId: event.companyId,
    runId: event.runId,
    conversationId: event.conversationId,
    revision: event.revision,
    status: event.status,
    kind: event.kind,
  })), [
    {
      type: 'task-run.changed',
      companyId: COMPANY,
      runId: created.id,
      conversationId: CONVO,
      revision: 1,
      status: 'running',
      kind: 'run.created',
    },
    {
      type: 'task-run.changed',
      companyId: COMPANY,
      runId: created.id,
      conversationId: CONVO,
      revision: 2,
      status: 'waiting_user',
      kind: 'action.wait_user',
    },
    {
      type: 'task-run.changed',
      companyId: COMPANY,
      runId: chat.taskRun.id,
      conversationId: CONVO,
      revision: 1,
      status: 'running',
      kind: 'run.created',
    },
  ])
  assert.equal(replay.revision, 2)
  assert.deepEqual(frames.map((event) => ({
    runId: event.runId,
    revision: event.revision,
    status: event.status,
    kind: event.kind,
  })), [
    { runId: created.id, revision: 1, status: 'running', kind: 'run.created' },
    { runId: created.id, revision: 2, status: 'waiting_user', kind: 'action.wait_user' },
    { runId: chat.taskRun.id, revision: 1, status: 'running', kind: 'run.created' },
  ])
  await new Promise<void>((resolve) => {
    socket.once('close', () => resolve())
    socket.close()
  })
  // The WS close handler releases presence asynchronously; let that write
  // finish before the suite tears down its shared PostgreSQL pool.
  await new Promise((resolve) => setTimeout(resolve, 50))

  // Mutate while disconnected, then emulate the store's hello/reconnect REST
  // reconciliation. The same entity advances in place even though its WS frame
  // was missed.
  const resumeResponse = await fetch(`${baseUrl}/api/task-runs/${created.id}/actions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-company-id': COMPANY },
    body: JSON.stringify({
      action: 'approve',
      expectedRevision: 2,
      idempotencyKey: 'realtime-resume-after-disconnect',
    }),
  })
  assert.equal(resumeResponse.status, 200)
  const recoveryResponse = await fetch(`${baseUrl}/api/task-runs?conversationId=${CONVO}`, {
    headers: { 'x-company-id': COMPANY },
  })
  assert.equal(recoveryResponse.status, 200)
  storeById = mergeTaskRunCache(storeById, await recoveryResponse.json() as TestTaskRun[])
  assert.equal(Object.keys(storeById).length, 2)
  assert.equal(storeById[created.id].revision, 3)
  assert.equal(storeById[created.id].status, 'running')
})
