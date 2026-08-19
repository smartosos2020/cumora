import { useEffect, useState } from 'react'
import type { ApiTaskRun, ApiTaskRunDetail } from '@/api/client'
import { cn } from '@/lib/utils'
import { useApp } from '@/stores/app'
import { useMe } from '@/stores/auth'
import { useParticipants } from '@/stores/participants'
import { useTaskRuns } from '@/stores/task-runs'

const STATUS_META = {
  running: { label: 'Running', dot: 'bg-skype', badge: 'bg-sky2-50 text-skype-deep border-sky2-200' },
  waiting_user: { label: 'Waiting for input', dot: 'bg-gold', badge: 'bg-gold/10 text-gold-deep border-gold/30' },
  blocked: { label: 'Blocked', dot: 'bg-coral', badge: 'bg-coral-soft text-coral-deep border-coral/20' },
  failed_recoverable: { label: 'Needs retry', dot: 'bg-coral', badge: 'bg-coral-soft text-coral-deep border-coral/20' },
  completed: { label: 'Completed', dot: 'bg-avail', badge: 'bg-avail/10 text-ink-700 border-avail/25' },
  paused: { label: 'Paused', dot: 'bg-ink-300', badge: 'bg-ink-50 text-ink-500 border-ink-100' },
  cancelled: { label: 'Cancelled', dot: 'bg-ink-300', badge: 'bg-ink-50 text-ink-400 border-ink-100' },
} as const

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(value))
}

function friendlyEvent(kind: string): string {
  if (kind === 'run.created') return 'Run created'
  if (kind.startsWith('action.')) {
    const action = kind.slice('action.'.length).replaceAll('_', ' ')
    return action.charAt(0).toUpperCase() + action.slice(1)
  }
  return kind.replaceAll('.', ' · ').replaceAll('_', ' ')
}

export function TaskRunStatusBadge({ run, compact = false }: { run: ApiTaskRun; compact?: boolean }) {
  const meta = STATUS_META[run.status]
  return (
    <span className={cn(
      'inline-flex shrink-0 items-center rounded-full border font-semibold',
      compact ? 'gap-1 px-2 py-0.5 text-[10px]' : 'gap-1.5 px-2.5 py-1 text-[11px]',
      meta.badge,
    )}>
      <span className={cn('rounded-full', compact ? 'h-1.5 w-1.5' : 'h-2 w-2', meta.dot, run.status === 'running' && 'animate-pulse-soft')} />
      {meta.label}
    </span>
  )
}

/** The only end-user mutation in this slice. All views call the same store
 * action, so the response and subsequent WS invalidation reconcile through
 * one revision-monotonic cache. */
export function TaskRunApproveButton({ run, compact = false }: { run: ApiTaskRun; compact?: boolean }) {
  const meId = useMe()
  const act = useTaskRuns((state) => state.act)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const isMine = !run.nextActorId || run.nextActorId === meId

  if (run.status !== 'waiting_user') return null

  const approve = async () => {
    if (busy || !isMine) return
    const expectedRevision = run.revision
    const idempotencyKey = `ui-approve-${crypto.randomUUID()}`
    setBusy(true)
    setNotice(null)
    try {
      const result = await act(run.id, { action: 'approve', expectedRevision, idempotencyKey })
      setNotice(result.idempotentReplay ? 'Already approved — latest state restored.' : 'Approved. Work is running again.')
    } catch (error) {
      // A 409 means another view/client won the revision race. Asking for at
      // least the next revision bypasses any cached detail and refreshes every
      // Task Run surface before we explain the conflict.
      try {
        const fresh = await useTaskRuns.getState().loadDetail(run.id, expectedRevision + 1)
        if (fresh.revision > expectedRevision) {
          setNotice(`This run changed elsewhere. Refreshed to revision ${fresh.revision}.`)
        } else {
          setNotice(error instanceof Error ? error.message : String(error))
        }
      } catch {
        setNotice(error instanceof Error ? error.message : String(error))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={cn('flex min-w-0', compact ? 'items-center gap-2' : 'flex-col items-start gap-1.5')}>
      <button
        type="button"
        onClick={(event) => { event.stopPropagation(); void approve() }}
        disabled={busy || !isMine}
        className={cn(
          'shrink-0 rounded-full bg-skype font-semibold text-white transition hover:bg-skype-deep disabled:cursor-not-allowed disabled:opacity-50',
          compact ? 'px-2.5 py-1 text-[10.5px]' : 'px-3.5 py-2 text-[12px]',
        )}
        title={isMine ? 'Approve and let the agent continue' : 'Approval belongs to another participant'}
      >
        {busy ? 'Refreshing…' : isMine ? 'Approve & continue' : 'Waiting on another teammate'}
      </button>
      {notice && <span role="status" className="min-w-0 text-[10.5px] leading-snug text-ink-500">{notice}</span>}
    </div>
  )
}

export function TaskRunMessageCard({ messageId }: { messageId: string }) {
  const runId = useTaskRuns((state) => state.allIds.find((id) => state.byId[id]?.sourceMessageId === messageId))
  const run = useTaskRuns((state) => runId ? state.byId[runId] : undefined)
  const openDetail = useApp((state) => state.openTaskRunDetail)
  const assignee = useParticipants((state) => run?.assigneeId ? state.byId[run.assigneeId] : undefined)

  if (!run) return null

  return (
    <div className="mt-2 max-w-[min(100%,580px)] rounded-[13px] border border-ink-100 bg-cloud/90 shadow-soft">
      <button
        type="button"
        onClick={() => openDetail(run.id)}
        className="flex w-full items-start gap-3 px-3.5 py-3 text-left transition hover:bg-sky2-50/60"
      >
        <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-[9px] bg-sky2-100 text-skype-deep" aria-hidden>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4"><path d="M8 6h12M8 12h12M8 18h12"/><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01"/></svg>
        </span>
        <span className="min-w-0 flex-1">
          <span className="mb-1 flex items-center gap-2">
            <span className="truncate text-[12.5px] font-bold text-ink-900">{run.title}</span>
            <TaskRunStatusBadge run={run} compact />
          </span>
          <span className="line-clamp-2 block text-[11.5px] leading-relaxed text-ink-500">
            {run.summary || `Assigned to ${assignee?.name ?? 'an agent'} · attempt ${run.currentAttempt}`}
          </span>
          <span className="mt-1 block text-[10px] text-ink-300">revision {run.revision} · updated {formatTime(run.updatedAt)}</span>
        </span>
        <span className="mt-1 text-sm text-ink-300" aria-hidden>→</span>
      </button>
      {run.status === 'waiting_user' && (
        <div className="border-t border-ink-100 px-3.5 py-2.5">
          <TaskRunApproveButton run={run} compact />
        </div>
      )}
    </div>
  )
}

export function TaskRunListCard({ run }: { run: ApiTaskRun }) {
  const openDetail = useApp((state) => state.openTaskRunDetail)
  const assignee = useParticipants((state) => run.assigneeId ? state.byId[run.assigneeId] : undefined)
  return (
    <article className="overflow-hidden rounded-[13px] border border-ink-100 bg-cloud shadow-soft">
      <button type="button" onClick={() => openDetail(run.id)} className="w-full px-3.5 py-3 text-left transition hover:bg-sky2-50/60">
        <div className="mb-2 flex items-start gap-2">
          <h3 className="min-w-0 flex-1 text-[13px] font-bold leading-snug text-ink-900">{run.title}</h3>
          <TaskRunStatusBadge run={run} compact />
        </div>
        <p className="line-clamp-2 text-[11.5px] leading-relaxed text-ink-500">{run.summary || 'No summary yet.'}</p>
        <div className="mt-2 flex items-center gap-1.5 text-[10px] text-ink-300">
          <span>{assignee?.name ?? 'Unassigned'}</span><span>·</span><span>attempt {run.currentAttempt}</span><span>·</span><span>r{run.revision}</span>
        </div>
      </button>
      {run.status === 'waiting_user' && (
        <div className="border-t border-ink-100 px-3.5 py-2.5"><TaskRunApproveButton run={run} compact /></div>
      )}
    </article>
  )
}

function JsonBlock({ value }: { value: Record<string, unknown> }) {
  if (Object.keys(value).length === 0) return null
  return <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-[10px] bg-ink-900 p-3 text-[10.5px] leading-relaxed text-cloud">{JSON.stringify(value, null, 2)}</pre>
}

export function TaskRunDetail({ runId }: { runId: string }) {
  const summary = useTaskRuns((state) => state.byId[runId])
  const detail = useTaskRuns((state) => state.details[runId])
  const loadDetail = useTaskRuns((state) => state.loadDetail)
  const error = useTaskRuns((state) => state.errors[runId])
  const [loadError, setLoadError] = useState<string | null>(null)
  const openList = useApp((state) => state.openTaskRuns)
  const close = useApp((state) => state.closeTaskRuns)
  const jumpToMessage = useApp((state) => state.jumpToMessage)
  const byId = useParticipants((state) => state.byId)

  useEffect(() => {
    setLoadError(null)
    void loadDetail(runId, summary?.revision ?? 0).catch((cause) => {
      setLoadError(cause instanceof Error ? cause.message : String(cause))
    })
  }, [loadDetail, runId, summary?.revision])

  const run: ApiTaskRunDetail | ApiTaskRun | undefined = detail ?? summary
  if (!run) {
    return (
      <div className="grid h-full place-items-center px-8 text-center text-[12px] text-ink-400">
        {error || loadError || 'Loading Task Run…'}
      </div>
    )
  }

  const assignee = run.assigneeId ? byId[run.assigneeId] : undefined
  const nextActor = run.nextActorId ? byId[run.nextActorId] : undefined
  const full = 'events' in run ? run : null

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-ink-100 px-4 py-3">
        <button type="button" onClick={openList} className="grid h-8 w-8 place-items-center rounded-full text-ink-500 transition hover:bg-cloud hover:text-ink-900" aria-label="Back to Task Runs">←</button>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-ink-300">Task Run detail</div>
          <div className="truncate text-[13px] font-bold text-ink-900">{run.title}</div>
        </div>
        <button type="button" onClick={close} className="grid h-8 w-8 place-items-center rounded-full border border-ink-100 bg-cloud/70 text-ink-500 transition hover:text-ink-900" aria-label="Close Task Run detail">×</button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <section className="border-b border-ink-100 px-5 py-5" style={{ background: 'radial-gradient(circle at 15% 0%, var(--sky-100), transparent 65%)' }}>
          <TaskRunStatusBadge run={run} />
          <h2 className="mt-3 font-display text-[23px] font-medium leading-tight tracking-tight text-ink-900">{run.title}</h2>
          {run.summary && <p className="mt-2 text-[12.5px] leading-relaxed text-ink-600">{run.summary}</p>}
          {run.consequence && <p className="mt-2 rounded-[9px] border-l-2 border-gold bg-gold/5 px-3 py-2 text-[11.5px] leading-relaxed text-ink-600"><b>Why it matters:</b> {run.consequence}</p>}
          <div className="mt-4"><TaskRunApproveButton run={run} /></div>
        </section>

        <section className="grid grid-cols-2 gap-2 border-b border-ink-100 px-5 py-4 text-[11px]">
          <div className="rounded-[9px] border border-ink-100 bg-cloud p-2.5"><div className="text-[9.5px] font-bold uppercase tracking-wider text-ink-300">Assignee</div><div className="mt-1 font-semibold text-ink-700">{assignee?.name ?? 'Unassigned'}</div></div>
          <div className="rounded-[9px] border border-ink-100 bg-cloud p-2.5"><div className="text-[9.5px] font-bold uppercase tracking-wider text-ink-300">Revision</div><div className="mt-1 font-mono font-semibold text-ink-700">{run.revision}</div></div>
          <div className="rounded-[9px] border border-ink-100 bg-cloud p-2.5"><div className="text-[9.5px] font-bold uppercase tracking-wider text-ink-300">Attempt</div><div className="mt-1 font-semibold text-ink-700">{run.currentAttempt}</div></div>
          <div className="rounded-[9px] border border-ink-100 bg-cloud p-2.5"><div className="text-[9.5px] font-bold uppercase tracking-wider text-ink-300">Next actor</div><div className="mt-1 font-semibold text-ink-700">{nextActor?.name ?? 'Agent'}</div></div>
        </section>

        {full?.sourceMessage && (
          <section className="border-b border-ink-100 px-5 py-4">
            <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.12em] text-ink-300">Source message</div>
            <button
              type="button"
              onClick={() => { close(); jumpToMessage(full.sourceMessage?.id ?? '') }}
              className="w-full rounded-[10px] border border-ink-100 bg-cloud px-3 py-2.5 text-left transition hover:border-sky2-200 hover:bg-sky2-50"
            >
              <div className="line-clamp-3 text-[11.5px] leading-relaxed text-ink-600">{full.sourceMessage.body}</div>
              <div className="mt-1.5 text-[10px] font-semibold text-skype-deep">Jump to message #{full.sourceMessage.sequence} →</div>
            </button>
          </section>
        )}

        <section className="border-b border-ink-100 px-5 py-4">
          <div className="mb-3 text-[10px] font-bold uppercase tracking-[0.12em] text-ink-300">Timeline</div>
          {!full && <div className="text-[11px] text-ink-400">Loading event history…</div>}
          {full?.events.map((event, index) => (
            <div key={event.id} className="relative flex gap-3 pb-4 last:pb-0">
              {index < full.events.length - 1 && <span className="absolute left-[5px] top-3 h-[calc(100%-4px)] w-px bg-ink-100" />}
              <span className="relative mt-1 h-[11px] w-[11px] shrink-0 rounded-full border-2 border-cloud bg-skype ring-1 ring-sky2-200" />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2"><span className="text-[11.5px] font-semibold text-ink-700">{friendlyEvent(event.kind)}</span><span className="ml-auto shrink-0 text-[9.5px] text-ink-300">r{event.revision}</span></div>
                <div className="mt-0.5 text-[10px] text-ink-400">{formatTime(event.createdAt)}{event.actorId && byId[event.actorId] ? ` · ${byId[event.actorId].name}` : ''}</div>
              </div>
            </div>
          ))}
        </section>

        {run.result && <section className="border-b border-ink-100 px-5 py-4"><div className="mb-2 text-[10px] font-bold uppercase tracking-[0.12em] text-ink-300">Result</div><JsonBlock value={run.result} /></section>}
        <footer className="px-5 py-4 text-[10px] text-ink-300">Created {formatTime(run.createdAt)} · updated {formatTime(run.updatedAt)} · {run.id}</footer>
      </div>
    </div>
  )
}
