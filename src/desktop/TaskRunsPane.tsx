import { useMemo } from 'react'
import { TaskRunDetail, TaskRunListCard } from '@/components/TaskRun'
import { useApp } from '@/stores/app'
import { useTaskRuns } from '@/stores/task-runs'

export function TaskRunsPane() {
  const pane = useApp((state) => state.taskRunPane)
  const conversationId = useApp((state) => state.selectedConversationId)
  const close = useApp((state) => state.closeTaskRuns)
  const allIds = useTaskRuns((state) => state.allIds)
  const byId = useTaskRuns((state) => state.byId)
  const loadedConversations = useTaskRuns((state) => state.loadedConversations)
  const loading = useTaskRuns((state) => state.loading)
  const error = useTaskRuns((state) => conversationId ? state.errors[`conversation:${conversationId}`] : undefined)

  const runs = useMemo(() => conversationId
    ? allIds.map((id) => byId[id]).filter((run) => run?.conversationId === conversationId)
    : [], [allIds, byId, conversationId])

  if (pane && pane !== 'list') return <TaskRunDetail runId={pane.runId} />

  const isLoaded = conversationId ? loadedConversations.has(conversationId) : false
  const isLoading = conversationId ? loading.has(`conversation:${conversationId}`) : false
  const waitingCount = runs.filter((run) => run.status === 'waiting_user').length

  return (
    <aside className="flex h-full min-h-0 flex-col border-l border-ink-100" style={{ background: 'linear-gradient(180deg, #FBFDFE, #F4F8FC)' }}>
      <header className="flex shrink-0 items-center gap-3 border-b border-ink-100 px-5 py-4">
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-[20px] font-medium tracking-tight text-ink-900">Task Runs</h2>
          <p className="mt-0.5 text-[10.5px] text-ink-400">
            {waitingCount > 0 ? `${waitingCount} waiting for input` : `${runs.length} in this conversation`}
          </p>
        </div>
        <button type="button" onClick={close} className="grid h-8 w-8 place-items-center rounded-full border border-ink-100 bg-cloud/70 text-ink-500 transition hover:text-ink-900" aria-label="Close Task Runs">×</button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {error && <div role="alert" className="mb-3 rounded-[10px] border border-coral/20 bg-coral-soft px-3 py-2 text-[11px] text-coral-deep">{error}</div>}
        {!isLoaded && isLoading && <div className="py-12 text-center text-[12px] text-ink-400">Loading Task Runs…</div>}
        {isLoaded && runs.length === 0 && (
          <div className="mx-auto mt-12 max-w-[260px] text-center">
            <div className="mx-auto grid h-11 w-11 place-items-center rounded-[13px] bg-sky2-100 text-skype-deep" aria-hidden>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5"><path d="M8 6h12M8 12h12M8 18h12"/><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01"/></svg>
            </div>
            <h3 className="mt-3 text-[13px] font-semibold text-ink-700">No runs in this chat yet</h3>
            <p className="mt-1 text-[11px] leading-relaxed text-ink-400">When a message starts delegated work, its live execution record will appear here.</p>
          </div>
        )}
        <div className="flex flex-col gap-2.5">
          {runs.map((run) => <TaskRunListCard key={run.id} run={run} />)}
        </div>
      </div>
    </aside>
  )
}
