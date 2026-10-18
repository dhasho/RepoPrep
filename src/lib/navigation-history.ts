export interface HistoryEntry<T> {
  readonly key: string
  readonly value: T
}

export interface NavigationHistory<T> {
  readonly entries: readonly HistoryEntry<T>[]
  readonly index: number
  readonly maxEntries: number
}

const DEFAULT_MAX_ENTRIES = 50

export function createNavigationHistory<T>(
  initialEntry: HistoryEntry<T>,
  maxEntries = DEFAULT_MAX_ENTRIES
): NavigationHistory<T> {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new RangeError('maxEntries must be a positive safe integer')
  }

  return {
    entries: [initialEntry],
    index: 0,
    maxEntries
  }
}

export function visitNavigation<T>(
  history: NavigationHistory<T>,
  entry: HistoryEntry<T>
): NavigationHistory<T> {
  const current = currentNavigation(history)
  if (current.key === entry.key) {
    const entries = history.entries.slice()
    entries[history.index] = entry
    return { ...history, entries }
  }

  const entries = [...history.entries.slice(0, history.index + 1), entry]
  const excess = entries.length - history.maxEntries
  if (excess > 0) entries.splice(0, excess)

  return {
    ...history,
    entries,
    index: entries.length - 1
  }
}

export function replaceNavigation<T>(
  history: NavigationHistory<T>,
  entry: HistoryEntry<T>
): NavigationHistory<T> {
  const entries = history.entries.slice()
  entries[history.index] = entry
  return { ...history, entries }
}

export function stepNavigation<T>(
  history: NavigationHistory<T>,
  delta: -1 | 1
): NavigationHistory<T> {
  const index = history.index + delta
  if (index < 0 || index >= history.entries.length) return history
  return { ...history, index }
}

export function currentNavigation<T>(history: NavigationHistory<T>): HistoryEntry<T> {
  return history.entries[history.index]
}
