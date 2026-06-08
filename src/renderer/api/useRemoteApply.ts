import { useEffect, useRef } from 'react'
import { api } from './index'
import { invalidateTable, REMOTE_APPLIED_TO_TABLE } from './ipcCache'
import type { IpcChannel } from '../../shared/types/ipc'

// =============================================================================
// useRemoteApply — desktop renderer subscription to *_REMOTE_APPLIED IPC events
// fired by sync-bootstrap.ts:210-252 after Phase 1.5c sync-pull applies remote
// rows to the local SQLite.
//
//   ┌─ pull tick (60s OR app focus OR triggerPull)                ┐
//   │   └─ applyRemoteMeetings(rows) → onMeetingsApplied([ids])   │
//   │       └─ wc.send(MEETINGS_REMOTE_APPLIED, {ids})            │
//   │                                                              │
//   ▼                                                              │
//   useRemoteApply(MEETINGS_REMOTE_APPLIED, cb)                    │
//   ├─ ipcCache.invalidateTable('meetings')   ← clear stale caches │
//   ├─ debounce 150ms (merge sub-batch storms)                     │
//   └─ cb(mergedIds)   ← screen-specific reload                    ┘
//
// Why the debounce: a first-launch pull can apply hundreds of rows in
// 50-row sub-batches. Each sub-batch fires its own `onApplied` →
// broadcast → useRemoteApply callback. Without debouncing, the open
// MeetingDetail / ChatSessionPanel would refetch ~20 times back-to-back.
// 150ms collapses same-channel events into ONE callback while still
// feeling real-time on steady-state single-row updates.
//
// The cache invalidation runs IMMEDIATELY on every event (no debounce)
// so any sibling component that re-renders during the debounce window
// reads fresh data. Only the user-supplied callback is debounced.
// =============================================================================

const DEBOUNCE_MS = 150

interface PendingDispatch {
  timer: ReturnType<typeof setTimeout>
  mergedIds: string[]
}

export function useRemoteApply(
  channel: IpcChannel,
  onApplied: (ids: string[]) => void,
): void {
  // Stash the callback in a ref so we don't tear down + re-subscribe on
  // every render. The effect only re-runs when the channel changes (rare).
  const callbackRef = useRef(onApplied)
  useEffect(() => {
    callbackRef.current = onApplied
  }, [onApplied])

  useEffect(() => {
    const table = REMOTE_APPLIED_TO_TABLE[channel]
    if (!table) {
      console.warn(
        `[useRemoteApply] unknown channel "${channel}" — no table mapping. ` +
          `Add it to REMOTE_APPLIED_TO_TABLE in api/ipcCache.ts.`,
      )
      return
    }

    const pending: PendingDispatch = { timer: undefined as never, mergedIds: [] }

    const unsubscribe = api.on(channel, (...args: unknown[]) => {
      // Broadcast payload shape from sync-bootstrap: { ids: string[] }.
      // Defensive parse — be tolerant of an empty/missing ids array.
      const payload = args[0] as { ids?: unknown } | undefined
      const ids = Array.isArray(payload?.ids)
        ? (payload.ids as unknown[]).filter((v): v is string => typeof v === 'string')
        : []

      // Invalidate the relevant ipcCache entries immediately so any
      // component that reads from that channel during the debounce
      // window gets fresh data. The user callback is what we debounce.
      invalidateTable(table)

      // Merge ids into the pending bucket. dedupe so a re-broadcast
      // doesn't produce duplicates.
      for (const id of ids) {
        if (!pending.mergedIds.includes(id)) pending.mergedIds.push(id)
      }

      // (Re)arm the debounce timer.
      if (pending.timer) clearTimeout(pending.timer)
      pending.timer = setTimeout(() => {
        const toFire = pending.mergedIds
        pending.mergedIds = []
        pending.timer = undefined as never
        try {
          callbackRef.current(toFire)
        } catch (err) {
          console.error(`[useRemoteApply] callback for "${channel}" threw:`, err)
        }
      }, DEBOUNCE_MS)
    })

    return () => {
      // Cancel any pending callback so it doesn't fire after the consumer
      // unmounts (would set state on an unmounted component → warning).
      if (pending.timer) clearTimeout(pending.timer)
      unsubscribe()
    }
  }, [channel])
}
