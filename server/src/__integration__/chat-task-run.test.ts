/**
 * Integration coverage for creating a Task Run through the real chat-message
 * HTTP route. The failure cases use PostgreSQL triggers so each insert fails
 * at the database boundary while the production transaction remains intact.
 */

import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { after, before, beforeEach, test } from 'node:test'
import { pool } from '../db/pool.js'
import {
  buildApiTestApp, ensureSchemaOnce, resetAllTables, seedUserMembership, teardownAll,
} from './_helpers.js'

const ME = 'u-chat-task-run'
const AGENT = 'a-chat-task-run'
const COMPANY = 'c-chat-task-run'
const CONVO = 'co-chat-task-run'
let server: Server
let baseUrl = ''

before(async () => {
  await ensureSchemaOnce()
  const app = await buildApiTestApp(ME)
  await new Promise<void>((resolve) => {
    server = createServer(app).listen(0, () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') baseUrl = `http://127.0.0.1:${addr.port}`
      resolve()
    })
  })
})

beforeEach(async () => {
  await resetAllTables()
  await seedWorld()
})

after(async () => {
  await teardownAll(server)
})

async function seedWorld(): Promise<void> {
  await pool.query(
    `INSERT INTO companies (id, name, slug, owner_user_id)
     VALUES ($1, 'Chat Task Run Co', 'chat-task-run-co', $2)`,
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
     VALUES ($1, 'group', 'Chat Task Run', $2::jsonb, 'group', $3)`,
    [CONVO, JSON.stringify([ME, AGENT]), COMPANY],
  )
}

interface PostedMessage {
  id?: string
  taskRun?: { sourceMessageId?: string }
}

async function postMessage(body: Record<string, unknown>): Promise<{
  status: number
  body: PostedMessage | null
}> {
  const res = await fetch(`${baseUrl}/api/conversations/${encodeURIComponent(CONVO)}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-company-id': COMPANY },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let parsed: PostedMessage | null = null
  try { parsed = JSON.parse(text) as PostedMessage } catch { /* Express error page */ }
  return { status: res.status, body: parsed }
}

async function rowCounts(): Promise<Record<string, number>> {
  const { rows } = await pool.query<{ messages: number; runs: number; attempts: number; events: number }>(
    `SELECT
       (SELECT COUNT(*)::int FROM messages WHERE conversation_id = $1) AS messages,
       (SELECT COUNT(*)::int FROM task_runs WHERE conversation_id = $1) AS runs,
       (SELECT COUNT(*)::int FROM task_run_attempts) AS attempts,
       (SELECT COUNT(*)::int FROM task_run_events WHERE company_id = $2) AS events`,
    [CONVO, COMPANY],
  )
  return rows[0]
}

test('[integration] chat message atomically binds its real id to the Run, attempt, and run.created event', async () => {
  const response = await postMessage({
    body: 'Prepare the launch checklist',
    clientId: 'client-chat-task-run',
    taskRun: {
      assigneeId: AGENT,
      title: 'Launch checklist',
      summary: 'Cover the production launch path',
      consequence: 'The release stays blocked until this is complete',
      metadata: { priority: 'high' },
    },
  })

  assert.equal(response.status, 202)
  assert.ok(response.body?.id)
  assert.equal(response.body?.taskRun?.sourceMessageId, response.body?.id)

  const { rows } = await pool.query<{
    message_id: string
    run_id: string
    source_message_id: string
    status: string
    assignee_id: string
    attempt_no: number
    attempt_status: string
    event_kind: string
    event_revision: number
    event_data: { trigger: string; conversationId: string; sourceMessageId: string }
    metadata: { trigger: string; clientId: string; priority: string }
  }>(
    `SELECT m.id AS message_id,
            tr.id AS run_id, tr.source_message_id, tr.status, tr.assignee_id, tr.metadata,
            tra.attempt_no, tra.status AS attempt_status,
            tre.kind AS event_kind, tre.revision AS event_revision, tre.data AS event_data
       FROM messages m
       JOIN task_runs tr ON tr.source_message_id = m.id
       JOIN task_run_attempts tra ON tra.run_id = tr.id
       JOIN task_run_events tre ON tre.run_id = tr.id AND tre.attempt_id = tra.id
      WHERE m.id = $1`,
    [response.body?.id],
  )

  assert.equal(rows.length, 1)
  const row = rows[0]
  assert.equal(row.source_message_id, row.message_id)
  assert.equal(row.status, 'running')
  assert.equal(row.assignee_id, AGENT)
  assert.equal(row.attempt_no, 1)
  assert.equal(row.attempt_status, 'running')
  assert.equal(row.event_kind, 'run.created')
  assert.equal(row.event_revision, 1)
  assert.equal(row.event_data.trigger, 'chat.message')
  assert.equal(row.event_data.conversationId, CONVO)
  assert.equal(row.event_data.sourceMessageId, row.message_id)
  assert.equal(row.metadata.trigger, 'chat.message')
  assert.equal(row.metadata.clientId, 'client-chat-task-run')
  assert.equal(row.metadata.priority, 'high')
  assert.deepEqual(await rowCounts(), { messages: 1, runs: 1, attempts: 1, events: 1 })
})

test('[integration] ordinary chat message succeeds without creating Task Run rows', async () => {
  const response = await postMessage({ body: 'This is only a chat message' })

  assert.equal(response.status, 202)
  assert.ok(response.body?.id)
  assert.equal(response.body?.taskRun, undefined)
  assert.deepEqual(await rowCounts(), { messages: 1, runs: 0, attempts: 0, events: 0 })
})

const failureStages = [
  { name: 'Run', table: 'task_runs' },
  { name: 'attempt', table: 'task_run_attempts' },
  { name: 'event', table: 'task_run_events' },
] as const

for (const stage of failureStages) {
  test(`[integration] ${stage.name} insert failure rolls back message, Run, attempt, and event`, async () => {
    const trigger = `test_fail_chat_${stage.table}`
    await pool.query(
      `CREATE OR REPLACE FUNCTION test_fail_chat_task_run_insert()
       RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         RAISE EXCEPTION 'forced chat Task Run insert failure';
       END;
       $$`,
    )
    await pool.query(
      `CREATE TRIGGER ${trigger}
       BEFORE INSERT ON ${stage.table}
       FOR EACH ROW EXECUTE FUNCTION test_fail_chat_task_run_insert()`,
    )

    try {
      const response = await postMessage({
        body: `Force the ${stage.name} failure`,
        taskRun: { assigneeId: AGENT, title: `Fail at ${stage.name}` },
      })

      assert.equal(response.status, 500)
      assert.deepEqual(await rowCounts(), { messages: 0, runs: 0, attempts: 0, events: 0 })
      const { rows: counters } = await pool.query(
        `SELECT 1 FROM conversation_counters WHERE conversation_id = $1`,
        [CONVO],
      )
      assert.equal(counters.length, 0, 'sequence allocation must roll back with the failed message')
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON ${stage.table}`)
      await pool.query('DROP FUNCTION IF EXISTS test_fail_chat_task_run_insert()')
    }
  })
}
