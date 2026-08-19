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
