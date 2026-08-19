import { randomUUID } from 'node:crypto'
import { type NextFunction, type Request, type Response, Router } from 'express'
import type { Pool, PoolClient } from 'pg'
import {
  isTaskRunStatus,
  type TaskRunStatus,
} from '../../../shared/task-run-state.js'
import type { AuthedRequest } from '../auth.js'
import {
  isTaskRunAction,
  planTaskRunAction,
  type TaskRunAction,
} from '../task-runs.js'

type CompanyContext = { userId: string; companyId: string }
type Queryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>

export interface TaskRunRouterDeps {
  pool: Pool
  requireCompany(req: Request & AuthedRequest): Promise<CompanyContext>
}

class TaskRunHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
  }
}

interface TaskRunRow {
  id: string
  companyId: string
  conversationId: string | null
  sourceMessageId: string | null
  createdBy: string
  assigneeId: string | null
  nextActorId: string | null
  title: string
  summary: string
  consequence: string
  status: TaskRunStatus
  pausedFromStatus: TaskRunStatus | null
  revision: number
  currentAttempt: number
  result: Record<string, unknown> | null
  metadata: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
  completedAt: Date | null
}

const RUN_SELECT = `
  r.id, r.company_id AS "companyId", r.conversation_id AS "conversationId",
  r.source_message_id AS "sourceMessageId", r.created_by AS "createdBy",
  r.assignee_id AS "assigneeId", r.next_actor_id AS "nextActorId",
  r.title, r.summary, r.consequence, r.status,
  r.paused_from_status AS "pausedFromStatus", r.revision,
  r.current_attempt AS "currentAttempt", r.result, r.metadata,
  r.created_at AS "createdAt", r.updated_at AS "updatedAt",
  r.completed_at AS "completedAt"`

function text(value: unknown, max = 20_000): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function optionalText(value: unknown, max = 2_000): string | null {
  const result = text(value, max)
  return result || null
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function route(handler: (req: Request & AuthedRequest, res: Response) => Promise<void>) {
  return async (req: Request & AuthedRequest, res: Response, next: NextFunction) => {
    try {
      await handler(req, res)
    } catch (error) {
      if (error instanceof TaskRunHttpError) {
        res.status(error.status).json({ error: error.message, code: error.code, ...error.details })
        return
      }
      next(error)
    }
  }
}

async function assertConversationAccess(
  db: Queryable,
  companyId: string,
  userId: string,
  conversationId: string,
  sourceMessageId: string | null,
): Promise<void> {
  const { rows } = await db.query(
    `SELECT c.id,
            CASE WHEN $4::text IS NULL THEN TRUE ELSE EXISTS (
              SELECT 1 FROM messages m WHERE m.id = $4 AND m.conversation_id = c.id
            ) END AS "messageExists"
       FROM conversations c
      WHERE c.id = $1 AND c.company_id = $2 AND c.members ? $3`,
    [conversationId, companyId, userId, sourceMessageId],
  )
  if (!rows[0]) throw new TaskRunHttpError(404, 'conversation not found')
  if (!rows[0].messageExists) throw new TaskRunHttpError(400, 'source message does not belong to conversation')
}

async function assertParticipant(db: Queryable, companyId: string, participantId: string | null): Promise<void> {
  if (!participantId) return
  const { rows } = await db.query(
    `SELECT 1 FROM participants
      WHERE id = $1 AND company_id = $2 AND departed_at IS NULL`,
    [participantId, companyId],
  )
  if (!rows[0]) throw new TaskRunHttpError(400, 'assignee is not an active company participant')
}

async function accessibleRun(
  db: Queryable,
  companyId: string,
  userId: string,
  runId: string,
  lock = false,
): Promise<TaskRunRow> {
  const { rows } = await db.query<TaskRunRow>(
    `SELECT ${RUN_SELECT}
       FROM task_runs r
      WHERE r.id = $1 AND r.company_id = $2
        AND (r.conversation_id IS NULL OR EXISTS (
          SELECT 1 FROM conversations c
           WHERE c.id = r.conversation_id AND c.company_id = r.company_id AND c.members ? $3
        ))
      ${lock ? 'FOR UPDATE' : ''}`,
    [runId, companyId, userId],
  )
  if (!rows[0]) throw new TaskRunHttpError(404, 'Task Run not found')
  return rows[0]
}

async function runDetail(db: Queryable, run: TaskRunRow) {
  const [attempts, events, source] = await Promise.all([
    db.query(
      `SELECT id, attempt_no AS "attemptNo", agent_run_id AS "agentRunId",
              status, error, output, started_at AS "startedAt", ended_at AS "endedAt"
         FROM task_run_attempts WHERE run_id = $1 ORDER BY attempt_no ASC`,
      [run.id],
    ),
    db.query(
      `SELECT id, attempt_id AS "attemptId", actor_id AS "actorId", kind,
              from_status AS "fromStatus", to_status AS "toStatus", revision,
              data, created_at AS "createdAt"
         FROM task_run_events WHERE run_id = $1 ORDER BY created_at ASC, id ASC`,
      [run.id],
    ),
    run.sourceMessageId
      ? db.query(
        `SELECT m.id, m.sequence, m.author_id AS "authorId", m.body
           FROM messages m WHERE m.id = $1 AND m.conversation_id = $2`,
        [run.sourceMessageId, run.conversationId],
      )
      : Promise.resolve({ rows: [] }),
  ])
  return {
    ...run,
    sourceMessage: source.rows[0] ?? null,
    sourceAvailable: Boolean(source.rows[0]),
    attempts: attempts.rows,
    events: events.rows,
  }
}

function actionNextActor(action: TaskRunAction, run: TaskRunRow, body: Record<string, unknown>): string | null {
  if (action === 'wait_user') return optionalText(body.nextActorId) ?? run.createdBy
  if (action === 'block') return optionalText(body.nextActorId) ?? run.assigneeId
  if (action === 'approve' || action === 'resume' || action === 'retry' || action === 'unblock') return run.assigneeId
  return null
}

export function createTaskRunRouter(deps: TaskRunRouterDeps): Router {
  const router = Router()
  const { pool } = deps

  router.get('/', route(async (req, res) => {
    const { userId, companyId } = await deps.requireCompany(req)
    const conversationId = optionalText(req.query.conversationId)
    const rawStatuses = typeof req.query.status === 'string' ? req.query.status.split(',').filter(Boolean) : []
    if (rawStatuses.some((status) => !isTaskRunStatus(status))) {
      throw new TaskRunHttpError(400, 'invalid Task Run status filter')
    }
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 250)
    const { rows } = await pool.query<TaskRunRow>(
      `SELECT ${RUN_SELECT}
         FROM task_runs r
        WHERE r.company_id = $1
          AND ($2::text IS NULL OR r.conversation_id = $2)
          AND (cardinality($3::text[]) = 0 OR r.status = ANY($3::text[]))
          AND (r.conversation_id IS NULL OR EXISTS (
            SELECT 1 FROM conversations c
             WHERE c.id = r.conversation_id AND c.company_id = r.company_id AND c.members ? $4
          ))
        ORDER BY CASE r.status
          WHEN 'waiting_user' THEN 0 WHEN 'blocked' THEN 1
          WHEN 'failed_recoverable' THEN 1 WHEN 'running' THEN 2 ELSE 3 END,
          r.updated_at DESC
        LIMIT $5`,
      [companyId, conversationId, rawStatuses, userId, limit],
    )
    res.json(rows)
  }))

  router.get('/:id', route(async (req, res) => {
    const { userId, companyId } = await deps.requireCompany(req)
    const run = await accessibleRun(pool, companyId, userId, text(req.params.id))
    res.json(await runDetail(pool, run))
  }))

  router.post('/', route(async (req, res) => {
    const { userId, companyId } = await deps.requireCompany(req)
    const title = text(req.body?.title, 300)
    const conversationId = optionalText(req.body?.conversationId)
    const sourceMessageId = optionalText(req.body?.sourceMessageId)
    const assigneeId = optionalText(req.body?.assigneeId)
    if (!title) throw new TaskRunHttpError(400, 'title required')
    if (!conversationId) throw new TaskRunHttpError(400, 'conversationId required')
    await assertConversationAccess(pool, companyId, userId, conversationId, sourceMessageId)
    await assertParticipant(pool, companyId, assigneeId)

    const id = `tr-${randomUUID()}`
    const attemptId = `tra-${randomUUID()}`
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query<TaskRunRow>(
        `INSERT INTO task_runs
          (id, company_id, conversation_id, source_message_id, created_by,
           assignee_id, next_actor_id, title, summary, consequence, status, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,'running',$10::jsonb)
         RETURNING ${RUN_SELECT.replaceAll('r.', '')}`,
        [id, companyId, conversationId, sourceMessageId, userId, assigneeId,
          title, text(req.body?.summary), text(req.body?.consequence), JSON.stringify(jsonObject(req.body?.metadata))],
      )
      await client.query(
        `INSERT INTO task_run_attempts (id, run_id, attempt_no, status) VALUES ($1,$2,1,'running')`,
        [attemptId, id],
      )
      await client.query(
        `INSERT INTO task_run_events
          (id, company_id, run_id, attempt_id, actor_id, kind, to_status, revision, data)
         VALUES ($1,$2,$3,$4,$5,'run.created','running',1,$6::jsonb)`,
        [`tre-${randomUUID()}`, companyId, id, attemptId, userId,
          JSON.stringify({ sourceMessageId, conversationId })],
      )
      await client.query('COMMIT')
      res.status(201).json(await runDetail(pool, rows[0]))
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }))

  router.post('/:id/actions', route(async (req, res) => {
    const { userId, companyId } = await deps.requireCompany(req)
    const action = req.body?.action
    const expectedRevision = req.body?.expectedRevision
    const idempotencyKey = text(req.body?.idempotencyKey, 200)
    if (!isTaskRunAction(action)) throw new TaskRunHttpError(400, 'invalid Task Run action')
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
      throw new TaskRunHttpError(400, 'expectedRevision must be a positive integer')
    }
    if (idempotencyKey.length < 8) throw new TaskRunHttpError(400, 'idempotencyKey must be at least 8 characters')

    const body = jsonObject(req.body)
    const runId = text(req.params.id)
    const client = await pool.connect()
    let updated: TaskRunRow
    let replayed = false
    try {
      await client.query('BEGIN')
      const run = await accessibleRun(client, companyId, userId, runId, true)
      const replay = await client.query(
        `SELECT 1 FROM task_run_events WHERE run_id = $1 AND idempotency_key = $2`,
        [run.id, idempotencyKey],
      )
      if (replay.rows[0]) {
        updated = run
        replayed = true
        await client.query('COMMIT')
      } else {
        if (run.revision !== expectedRevision) {
          throw new TaskRunHttpError(409, 'Task Run revision is stale', 'TASK_RUN_REVISION_CONFLICT', {
            latest: run,
          })
        }
        if (action === 'approve' && run.nextActorId && run.nextActorId !== userId) {
          throw new TaskRunHttpError(403, 'approval belongs to another participant')
        }

        let plan
        try {
          plan = planTaskRunAction(action, run.status, run.pausedFromStatus)
        } catch (error) {
          throw new TaskRunHttpError(409, error instanceof Error ? error.message : 'invalid Task Run transition', 'INVALID_TASK_RUN_TRANSITION', {
            latest: run,
          })
        }

        const attempt = await client.query<{ id: string }>(
          `SELECT id FROM task_run_attempts WHERE run_id = $1 AND attempt_no = $2`,
          [run.id, run.currentAttempt],
        )
        if (!attempt.rows[0]) throw new Error('Task Run current attempt is missing')

        if (plan.finishAttemptAs) {
          await client.query(
            `UPDATE task_run_attempts
                SET status = $1, error = $2, output = $3::jsonb, ended_at = NOW()
              WHERE id = $4 AND ended_at IS NULL`,
            [plan.finishAttemptAs, action === 'fail' ? optionalText(body.reason, 8_000) : null,
              action === 'complete' ? JSON.stringify(jsonObject(body.result)) : null, attempt.rows[0].id],
          )
        }

        let attemptId = attempt.rows[0].id
        const nextAttempt = plan.startsNewAttempt ? run.currentAttempt + 1 : run.currentAttempt
        if (plan.startsNewAttempt) {
          attemptId = `tra-${randomUUID()}`
          await client.query(
            `INSERT INTO task_run_attempts (id, run_id, attempt_no, status)
             VALUES ($1,$2,$3,'running')`,
            [attemptId, run.id, nextAttempt],
          )
        }

        const nextRevision = run.revision + 1
        const nextActorId = actionNextActor(action, run, body)
        const result = action === 'complete' ? jsonObject(body.result) : run.result
        const { rows } = await client.query<TaskRunRow>(
          `UPDATE task_runs r SET
             status = $1, paused_from_status = $2, revision = $3,
             current_attempt = $4, next_actor_id = $5, result = $6::jsonb,
             summary = CASE WHEN $7::text = '' THEN summary ELSE $7 END,
             consequence = CASE WHEN $8::text = '' THEN consequence ELSE $8 END,
             completed_at = CASE WHEN $1 IN ('completed','cancelled') THEN NOW() ELSE NULL END,
             updated_at = NOW()
           WHERE id = $9
           RETURNING ${RUN_SELECT}`,
          [plan.toStatus, plan.pausedFromStatus, nextRevision, nextAttempt, nextActorId,
            result ? JSON.stringify(result) : null, text(body.summary), text(body.consequence), run.id],
        )
        updated = rows[0]
        await client.query(
          `INSERT INTO task_run_events
            (id, company_id, run_id, attempt_id, actor_id, kind, from_status,
             to_status, revision, idempotency_key, data)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
          [`tre-${randomUUID()}`, companyId, run.id, attemptId, userId, `action.${action}`,
            run.status, plan.toStatus, nextRevision, idempotencyKey,
            JSON.stringify({ reason: optionalText(body.reason, 8_000) })],
        )
        await client.query('COMMIT')
      }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }

    res.json({ ...(await runDetail(pool, updated)), idempotentReplay: replayed })
  }))

  return router
}
