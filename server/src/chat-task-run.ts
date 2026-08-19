import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'

export class ChatTaskRunError extends Error {}

export interface ChatTaskRunDraft {
  assigneeId: string
  title: string
  summary: string
  consequence: string
  metadata: Record<string, unknown>
}

export interface CreatedChatTaskRun {
  id: string
  status: 'running'
  sourceMessageId: string
  assigneeId: string
  revision: 1
}

function clippedText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

/** Parse the optional `taskRun` envelope accepted by chat message creation.
 *  `undefined` means an ordinary chat message. Once the envelope is present,
 *  assigneeId is required so a chat delegation never creates an ownerless Run. */
export function parseChatTaskRunDraft(raw: unknown, messageBody: string): ChatTaskRunDraft | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ChatTaskRunError('taskRun must be an object')
  }
  const input = raw as Record<string, unknown>
  const assigneeId = clippedText(input.assigneeId, 200)
  if (!assigneeId) throw new ChatTaskRunError('taskRun.assigneeId required')
  const title = clippedText(input.title, 300) || clippedText(messageBody, 300)
  if (!title) throw new ChatTaskRunError('taskRun.title required')
  return {
    assigneeId,
    title,
    summary: clippedText(input.summary, 20_000),
    consequence: clippedText(input.consequence, 20_000),
    metadata: objectValue(input.metadata),
  }
}

export async function assertChatTaskRunAssignee(
  db: Pick<PoolClient, 'query'>,
  args: { companyId: string; conversationMembers: string[]; assigneeId: string },
): Promise<void> {
  if (!args.conversationMembers.includes(args.assigneeId)) {
    throw new ChatTaskRunError('taskRun assignee must be a conversation member')
  }
  const { rows } = await db.query(
    `SELECT 1 FROM participants
      WHERE id = $1 AND company_id = $2 AND kind = 'agent' AND departed_at IS NULL`,
    [args.assigneeId, args.companyId],
  )
  if (!rows[0]) throw new ChatTaskRunError('taskRun assignee must be an active agent')
}

/** Create the execution record that belongs to one chat message. The caller
 *  supplies an open transaction so message + Run remain all-or-nothing. */
export async function createChatTaskRun(
  db: Pick<PoolClient, 'query'>,
  args: {
    companyId: string
    conversationId: string
    sourceMessageId: string
    createdBy: string
    draft: ChatTaskRunDraft
    clientId: string | null
  },
): Promise<CreatedChatTaskRun> {
  const id = `tr-${randomUUID()}`
  const attemptId = `tra-${randomUUID()}`
  const metadata = {
    ...args.draft.metadata,
    trigger: 'chat.message',
    ...(args.clientId ? { clientId: args.clientId } : {}),
  }
  await db.query(
    `INSERT INTO task_runs
      (id, company_id, conversation_id, source_message_id, created_by,
       assignee_id, next_actor_id, title, summary, consequence, status, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,'running',$10::jsonb)`,
    [id, args.companyId, args.conversationId, args.sourceMessageId, args.createdBy,
      args.draft.assigneeId, args.draft.title, args.draft.summary,
      args.draft.consequence, JSON.stringify(metadata)],
  )
  await db.query(
    `INSERT INTO task_run_attempts (id, run_id, attempt_no, status)
     VALUES ($1,$2,1,'running')`,
    [attemptId, id],
  )
  await db.query(
    `INSERT INTO task_run_events
      (id, company_id, run_id, attempt_id, actor_id, kind, to_status, revision, data)
     VALUES ($1,$2,$3,$4,$5,'run.created','running',1,$6::jsonb)`,
    [`tre-${randomUUID()}`, args.companyId, id, attemptId, args.createdBy,
      JSON.stringify({
        trigger: 'chat.message',
        conversationId: args.conversationId,
        sourceMessageId: args.sourceMessageId,
      })],
  )
  return {
    id,
    status: 'running',
    sourceMessageId: args.sourceMessageId,
    assigneeId: args.draft.assigneeId,
    revision: 1,
  }
}
