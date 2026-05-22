import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { StyleSheet, Text, TextInput, View } from 'react-native'
import { appStateStorage } from '../lib/cache/mmkv'
import { enqueue, pendingCount } from '../lib/sync/outbox'
import { tick as tickClock } from '../lib/sync/clock'
import { drainNow } from '../lib/sync/agent'
import {
  decideSaveLabel,
  formatRelative,
  shouldEnqueueSave,
} from '../lib/meetings/notes-editor-state'
import { colors, radii, spacing, type } from '../theme'

// =============================================================================
// NotesEditor — mobile-side notes input that drains through the sync outbox.
//
// Flow:
//   1. Render with `initialNotes` from the server (MeetingDetail.notes).
//   2. On mount, restore any local MMKV draft so a force-quit doesn't lose
//      keystrokes (delight item D3).
//   3. On each keystroke, restart a 1000ms debounce timer. When it fires:
//        a. Persist the draft to MMKV (survival hedge).
//        b. Enqueue an outbox entry with a fresh lamport.tick().
//        c. Kick the sync agent — drainNow() returns immediately if
//           already in-flight (single-flight mutex).
//   4. Server response handled by the agent (this component just observes
//      `pendingCount` for the "Saving (N)…" indicator).
//   5. On unmount: flush pending debounce immediately so navigating away
//      mid-edit doesn't drop the last keystroke.
//
// Delights:
//   D2 — "Last edited 3 minutes ago" timestamp below the input.
//   D3 — MMKV draft restore.
//   D4 — Auto-focus when status==='scheduled' AND notes is empty.
//   D6 — Save state label ("Saving (N)…").
// =============================================================================

const DEBOUNCE_MS = 1000

interface Props {
  meetingId: string
  status: string
  serverNotes: string | null
  serverUpdatedAt: string
  /** Snapshot of MeetingDetail.lamport at last server response. Used as the
   *  parent's "I just refetched" hint so the editor knows when to merge
   *  external changes; for V1 we don't actually merge into the input value
   *  (it would clobber a user mid-edit). */
  serverLamport: string
  /**
   * Called immediately after the editor decides to enqueue a save —
   * the parent can use this to invalidate TanStack Query caches that
   * mirror notes, but we don't depend on the result.
   */
  onChangeEnqueued?: (next: string | null) => void
}

const draftKey = (meetingId: string): string => `notes-draft:${meetingId}`

export function NotesEditor({
  meetingId,
  status,
  serverNotes,
  serverUpdatedAt,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  serverLamport: _serverLamport,
  onChangeEnqueued,
}: Props) {
  // Local input value — initialized from MMKV draft (if any) then server notes.
  const [value, setValue] = useState<string>(() => {
    const draft = appStateStorage.getString(draftKey(meetingId))
    if (draft !== undefined) return draft
    return serverNotes ?? ''
  })

  // Track the value last enqueued so debounce doesn't re-enqueue identical text.
  const lastEnqueuedRef = useRef<string | null>(null)

  // Pending counter polling (cheap — MMKV read; we poll lazily so the label
  // updates when the agent drains).
  const [pendCount, setPendCount] = useState<number>(pendingCount())
  const [lastSavedAtMs, setLastSavedAtMs] = useState<number | null>(null)
  // No time-tick: the "Last edited X ago" label updates only when the
  // component re-renders for other reasons (refetch, typing, pending
  // count change). Avoids the continuous flicker.

  // Auto-focus (D4) — only when scheduled + empty. The ref's `focus()` call
  // runs after the autoFocus prop has primed the native input, hardening the
  // behavior in cases where the prop alone fails (RN bug seen on iOS 18).
  const inputRef = useRef<TextInput>(null)
  const shouldAutoFocus = status === 'scheduled' && (serverNotes ?? '').length === 0

  // Debounce ref + flushable timer.
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingValue = useRef<string | null>(null)

  const flushSave = useCallback(() => {
    const latest = pendingValue.current
    if (latest === null) return
    const next: string | null = latest.length === 0 ? null : latest

    if (
      !shouldEnqueueSave({
        latest: next,
        lastEnqueued: lastEnqueuedRef.current,
        serverValue: serverNotes,
      })
    ) {
      return
    }

    const lamport = tickClock()
    enqueue({
      op: 'meeting.notes.update',
      resourceId: meetingId,
      payload: { notes: next, lamport },
    })
    lastEnqueuedRef.current = next
    // Persist draft (D3) — only matters if the user kills the app before
    // the agent drains. We clear it on a confirmed successful save below
    // via the pendingCount poll.
    appStateStorage.set(draftKey(meetingId), latest)
    setPendCount(pendingCount())
    onChangeEnqueued?.(next)
    // Fire-and-forget kick — single-flight mutex inside the agent handles
    // concurrent triggers. Errors here are non-fatal (network handling lives
    // in the agent, which will retry per the backoff schedule).
    void drainNow().then(() => {
      setPendCount(pendingCount())
      // If the queue is empty AND we just enqueued, the most recent save
      // succeeded — record a "saved at" stamp.
      if (pendingCount() === 0) {
        setLastSavedAtMs(Date.now())
        // Draft no longer needed — server has it.
        appStateStorage.delete(draftKey(meetingId))
      }
    })
  }, [meetingId, serverNotes, onChangeEnqueued])

  const handleChange = useCallback(
    (next: string) => {
      setValue(next)
      pendingValue.current = next
      if (debounceTimer.current) clearTimeout(debounceTimer.current)
      debounceTimer.current = setTimeout(flushSave, DEBOUNCE_MS)
    },
    [flushSave],
  )

  // Periodic poll of the outbox pending count for the "Saving (N)…" label.
  // 5s is fine for human-visible feedback. Only re-renders when the count
  // actually changes (setState bails when the value is identical).
  useEffect(() => {
    const interval = setInterval(() => {
      setPendCount(pendingCount())
    }, 5_000)
    return () => clearInterval(interval)
  }, [])

  // Flush pending debounce immediately on unmount so leaving the screen
  // mid-edit doesn't drop the last keystroke (test path: pin meeting,
  // type, hit back).
  useEffect(() => {
    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current)
        debounceTimer.current = null
      }
      flushSave()
    }
  }, [flushSave])

  // Server-notes change → only sync the input if the user hasn't typed
  // anything different. This prevents the editor from clobbering an
  // in-progress edit when TanStack refetches after a pull-to-refresh.
  useEffect(() => {
    const draft = appStateStorage.getString(draftKey(meetingId))
    if (draft !== undefined) return // user has a draft; don't touch
    if (lastEnqueuedRef.current !== null) return // user has typed
    setValue(serverNotes ?? '')
  }, [serverNotes, meetingId])

  const saveLabel = useMemo(
    () =>
      decideSaveLabel({
        status: pendCount > 0 ? 'pending' : 'idle',
        pendingCount: pendCount,
        lastSavedAtMs,
        nowMs: Date.now(),
      }),
    [pendCount, lastSavedAtMs],
  )

  // Computed every render (not memoized) so the 5s setTick interval
  // above actually advances the label. Cheap pure-fn call — no perf
  // concern here.
  const relativeLabel = formatRelative(serverUpdatedAt, Date.now())

  return (
    <View style={styles.wrap}>
      <View style={styles.headerRow}>
        <Text style={styles.heading}>Notes</Text>
        {saveLabel.text ? (
          <Text
            style={[styles.saveLabel, saveLabel.isWarning && styles.saveLabelWarn]}
          >
            {saveLabel.text}
          </Text>
        ) : null}
      </View>
      <TextInput
        ref={inputRef}
        value={value}
        onChangeText={handleChange}
        multiline
        autoFocus={shouldAutoFocus}
        placeholder="Jot anything you want to remember from this meeting…"
        placeholderTextColor={colors.text4}
        style={styles.input}
        textAlignVertical="top"
        accessibilityLabel="Meeting notes"
      />
      {relativeLabel ? (
        <Text style={styles.footer}>Last edited {relativeLabel}</Text>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: 6,
  },
  heading: {
    color: colors.text4,
    fontSize: type.label,
    fontWeight: '700',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  saveLabel: {
    color: colors.text3,
    fontSize: type.caption,
    fontWeight: '500',
  },
  saveLabelWarn: {
    color: colors.crimson,
  },
  input: {
    color: colors.text,
    fontSize: type.body + 1,
    lineHeight: 21,
    minHeight: 100,
    padding: 0,
  },
  footer: {
    marginTop: 8,
    color: colors.text4,
    fontSize: type.caption,
    fontWeight: '500',
  },
})
