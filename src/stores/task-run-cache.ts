export interface TaskRunCacheEntry {
  id: string
  revision: number
  updatedAt: string
}

export class TrailingRefreshQueue<Key> {
  private readonly inFlight = new Map<Key, Promise<void>>()
  private readonly refreshQueued = new Set<Key>()

  async run(key: Key, request: () => Promise<void>, isCurrent: () => boolean): Promise<void> {
    const existingRequest = this.inFlight.get(key)
    if (existingRequest) {
      this.refreshQueued.add(key)
      await existingRequest
      return
    }

    const activeRequest = request()
    this.inFlight.set(key, activeRequest)
    try {
      await activeRequest
    } finally {
      if (this.inFlight.get(key) === activeRequest) this.inFlight.delete(key)
      if (this.refreshQueued.delete(key) && isCurrent()) await this.run(key, request, isCurrent)
    }
  }
}

export function mergeTaskRunCache<T extends TaskRunCacheEntry>(
  current: Record<string, T>,
  incoming: T[],
): Record<string, T> {
  const next = { ...current }
  for (const run of incoming) {
    const existing = next[run.id]
    if (!existing || run.revision >= existing.revision) next[run.id] = run
  }
  return next
}

export function mergeTaskRunDetailCache<T extends TaskRunCacheEntry>(
  current: Record<string, T>,
  incoming: T,
  minimumRevision = 0,
): Record<string, T> {
  const existingRevision = current[incoming.id]?.revision ?? 0
  if (incoming.revision < Math.max(existingRevision, minimumRevision)) return current
  return { ...current, [incoming.id]: incoming }
}

export function orderedTaskRunIds<T extends TaskRunCacheEntry>(byId: Record<string, T>): string[] {
  return Object.values(byId)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .map((run) => run.id)
}

export function mergeTaskRunConversationCache<
  T extends TaskRunCacheEntry & { conversationId: string | null },
>(
  current: Record<string, T>,
  incoming: T[],
  conversationId: string,
  idsAtRequestStart: ReadonlySet<string>,
): Record<string, T> {
  const received = new Set(incoming.map((run) => run.id))
  const retained = Object.fromEntries(Object.entries(current).filter(
    ([id, run]) => run.conversationId !== conversationId
      || received.has(id)
      || !idsAtRequestStart.has(id),
  )) as Record<string, T>
  return mergeTaskRunCache(retained, incoming)
}
