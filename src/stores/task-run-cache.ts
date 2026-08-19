export interface TaskRunCacheEntry {
  id: string
  revision: number
  updatedAt: string
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
