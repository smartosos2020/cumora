import { create } from 'zustand'
import {
  type ApiTaskRun,
  type ApiTaskRunAction,
  type ApiTaskRunDetail,
  api,
  type WsEvent,
  ws,
} from '@/api/client'

interface TaskRunsState {
  byId: Record<string, ApiTaskRun>
  details: Record<string, ApiTaskRunDetail>
  allIds: string[]
  loadedAll: boolean
  loadedConversations: Set<string>
  loading: Set<string>
  errors: Record<string, string>

  reset: () => void
  loadAll: () => Promise<void>
  loadConversation: (conversationId: string) => Promise<void>
  loadDetail: (id: string, minimumRevision?: number) => Promise<ApiTaskRunDetail>
  act: (
    id: string,
    input: Parameters<typeof api.actOnTaskRun>[1],
  ) => Promise<ApiTaskRunDetail>
  applyEvent: (event: Extract<WsEvent, { type: 'task-run.changed' }>) => void
}

// Store singletons outlive an AuthedApp remount. Incrementing this token on
// reset prevents a request started in workspace A from writing its response
// into workspace B after a fast company switch.
let taskRunsEpoch = 0

function newestFirst(a: ApiTaskRun, b: ApiTaskRun): number {
  return Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
}

function mergeRuns(
  current: Record<string, ApiTaskRun>,
  incoming: ApiTaskRun[],
): Record<string, ApiTaskRun> {
  const next = { ...current }
  for (const run of incoming) {
    const existing = next[run.id]
    if (!existing || run.revision >= existing.revision) next[run.id] = run
  }
  return next
}

function orderedIds(byId: Record<string, ApiTaskRun>): string[] {
  return Object.values(byId).sort(newestFirst).map((run) => run.id)
}

export const useTaskRuns = create<TaskRunsState>((set, get) => ({
  byId: {},
  details: {},
  allIds: [],
  loadedAll: false,
  loadedConversations: new Set(),
  loading: new Set(),
  errors: {},

  reset: () => {
    taskRunsEpoch += 1
    set({
      byId: {},
      details: {},
      allIds: [],
      loadedAll: false,
      loadedConversations: new Set(),
      loading: new Set(),
      errors: {},
    })
  },

  loadAll: async () => {
    const epoch = taskRunsEpoch
    const key = 'all'
    if (get().loading.has(key)) return
    set((state) => ({ loading: new Set(state.loading).add(key) }))
    try {
      const runs = await api.listTaskRuns({ limit: 250 })
      if (epoch !== taskRunsEpoch) return
      set((state) => {
        const byId = mergeRuns(state.byId, runs)
        return {
          byId,
          allIds: orderedIds(byId),
          loadedAll: true,
          errors: { ...state.errors, [key]: '' },
        }
      })
    } catch (error) {
      if (epoch !== taskRunsEpoch) return
      set((state) => ({
        errors: { ...state.errors, [key]: error instanceof Error ? error.message : String(error) },
      }))
    } finally {
      if (epoch !== taskRunsEpoch) return
      set((state) => {
        const loading = new Set(state.loading)
        loading.delete(key)
        return { loading }
      })
    }
  },

  loadConversation: async (conversationId) => {
    const epoch = taskRunsEpoch
    const key = `conversation:${conversationId}`
    if (get().loading.has(key)) return
    set((state) => ({ loading: new Set(state.loading).add(key) }))
    try {
      const runs = await api.listTaskRuns({ conversationId, limit: 250 })
      if (epoch !== taskRunsEpoch) return
      set((state) => {
        // A successful scoped read is authoritative for this conversation:
        // remove cached rows no longer returned, while retaining other rooms.
        const received = new Set(runs.map((run) => run.id))
        const retained = Object.fromEntries(Object.entries(state.byId).filter(
          ([id, run]) => run.conversationId !== conversationId || received.has(id),
        ))
        const byId = mergeRuns(retained, runs)
        const loadedConversations = new Set(state.loadedConversations).add(conversationId)
        return {
          byId,
          allIds: orderedIds(byId),
          loadedConversations,
          errors: { ...state.errors, [key]: '' },
        }
      })
    } catch (error) {
      if (epoch !== taskRunsEpoch) return
      set((state) => ({
        errors: { ...state.errors, [key]: error instanceof Error ? error.message : String(error) },
      }))
    } finally {
      if (epoch !== taskRunsEpoch) return
      set((state) => {
        const loading = new Set(state.loading)
        loading.delete(key)
        return { loading }
      })
    }
  },

  loadDetail: async (id, minimumRevision = 0) => {
    const epoch = taskRunsEpoch
    const cached = get().details[id]
    if (cached && cached.revision >= minimumRevision) return cached
    const detail = await api.getTaskRun(id)
    if (epoch !== taskRunsEpoch) throw new Error('Task Run workspace changed')
    set((state) => {
      const existing = state.byId[id]
      if (existing && existing.revision > detail.revision) return {}
      const byId = mergeRuns(state.byId, [detail])
      return {
        byId,
        details: { ...state.details, [id]: detail },
        allIds: orderedIds(byId),
      }
    })
    return detail
  },

  act: async (id, input) => {
    const epoch = taskRunsEpoch
    const detail = await api.actOnTaskRun(id, input)
    if (epoch !== taskRunsEpoch) throw new Error('Task Run workspace changed')
    set((state) => {
      const byId = mergeRuns(state.byId, [detail])
      return {
        byId,
        details: { ...state.details, [id]: detail },
        allIds: orderedIds(byId),
      }
    })
    return detail
  },

  applyEvent: (event) => {
    const knownRevision = get().byId[event.runId]?.revision ?? 0
    if (knownRevision >= event.revision && get().details[event.runId]) return
    // WS is an ordered invalidation stream, not a competing data model. The
    // canonical detail endpoint supplies the row, attempts, and event history
    // used by message cards, conversation sidebar, and detail view alike.
    void get().loadDetail(event.runId, event.revision).catch((error) => {
      set((state) => ({
        errors: {
          ...state.errors,
          [event.runId]: error instanceof Error ? error.message : String(error),
        },
      }))
    })
  },
}))

export function taskRunsForConversation(
  state: Pick<TaskRunsState, 'byId' | 'allIds'>,
  conversationId: string,
): ApiTaskRun[] {
  return state.allIds
    .map((id) => state.byId[id])
    .filter((run): run is ApiTaskRun => Boolean(run) && run.conversationId === conversationId)
}

let wsBound = false
export function bootTaskRuns(): void {
  useTaskRuns.getState().reset()
  void useTaskRuns.getState().loadAll()
  if (wsBound) return
  wsBound = true
  ws.connect()
  ws.on((event) => {
    if (event.type === 'hello') {
      // Redis does not retain missed events. A complete REST reconciliation on
      // every reconnect also repairs any best-effort publish failure.
      void useTaskRuns.getState().loadAll()
      return
    }
    if (event.type === 'task-run.changed') useTaskRuns.getState().applyEvent(event)
  })
}

export type { ApiTaskRunAction }
