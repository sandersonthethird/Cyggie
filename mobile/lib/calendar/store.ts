import { create } from 'zustand'
import { appStateStorage } from '../cache/mmkv'

// Dismissed-event ids for the Calendar tab.
//
// Matches desktop's app.store.dismissedEventIds — partners can swipe a
// noisy recurring event (Lunch, Focus block) and have it filtered out
// of all three calendar segments. Persisted to MMKV so dismissals
// survive cold starts. Bulk-restored via the account sheet.
//
// Persistence shape: JSON-serialized array of ids under STORAGE_KEY.
// We re-serialize the full array on every mutation; the set is bounded
// in practice (< 50 ids — partners aren't dismissing thousands).

const STORAGE_KEY = 'calendar.dismissedIds'

function loadInitial(): Set<string> {
  const raw = appStateStorage.getString(STORAGE_KEY)
  if (!raw) return new Set()
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) return new Set(parsed.filter((x): x is string => typeof x === 'string'))
  } catch {
    // Corrupt MMKV blob — discard and start fresh; better than crash-loop.
  }
  return new Set()
}

function persist(ids: Set<string>): void {
  if (ids.size === 0) {
    appStateStorage.delete(STORAGE_KEY)
    return
  }
  appStateStorage.set(STORAGE_KEY, JSON.stringify(Array.from(ids)))
}

interface CalendarStore {
  dismissedIds: Set<string>
  isDismissed: (id: string) => boolean
  dismiss: (id: string) => void
  undismissAll: () => void
}

export const useCalendarStore = create<CalendarStore>((set, get) => ({
  dismissedIds: loadInitial(),

  isDismissed: (id) => get().dismissedIds.has(id),

  dismiss: (id) => {
    const current = get().dismissedIds
    if (current.has(id)) return
    const next = new Set(current)
    next.add(id)
    persist(next)
    set({ dismissedIds: next })
  },

  undismissAll: () => {
    if (get().dismissedIds.size === 0) return
    persist(new Set())
    set({ dismissedIds: new Set() })
  },
}))
