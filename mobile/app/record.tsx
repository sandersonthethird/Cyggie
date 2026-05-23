// =============================================================================
// record.tsx — recording UI route.
//
// State-driven by useRecordingStore:
//
//   idle          → transient: mount logic is in flight (gateway probe +
//                   startRecording's permission/audio-session setup). Shows a
//                   "Starting…" spinner with Cancel as escape hatch. A 5s
//                   watchdog surfaces "Microphone unavailable" if
//                   Audio.Recording.createAsync hangs.
//   recording     → big elapsed timer + crimson Stop button. iOS shows a
//                   red status bar via UIBackgroundModes:audio.
//   uploading     → "Uploading…" + progress bar (uploadProgress).
//   transcribing  → "Transcribing… We'll notify you when it's ready." +
//                   "Done" button that returns to Calendar.
//   done          → fallback path (push usually navigates straight to
//                   /meetings/[id]); manual return to Calendar.
//   error         → message + Retry button (back to idle) + Cancel button.
//
// We don't display in-meeting partial transcripts — that's deliberately
// dropped per the M3 architecture pivot. The whole upload-then-transcribe
// model trades live partials for simpler reliability + battery life.
// =============================================================================

import { useEffect, useState } from 'react'
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router, useLocalSearchParams } from 'expo-router'
import {
  cancelRecording,
  discardPendingUpload,
  retryPendingUpload,
  startRecording,
  stopRecording,
} from '../lib/recording/session'
import {
  discardPendingUploadFileById,
  loadMostRecentPendingUploadOrEvict,
  type PendingUpload,
} from '../lib/recording/pending-upload'
import { useRecordingStore } from '../lib/recording/store'
import { useTranscribingPoll } from '../lib/recording/use-transcribing-poll'
import { useAuthStore } from '../lib/auth/store'
import { fetchMeeting } from '../lib/api/meetings'
import { ApiError } from '../lib/api/client'
import {
  decideMountAction,
  type MeetingProbeResult,
} from '../lib/recording/mount-action'
import { colors, radii, spacing, type } from '../theme'

/**
 * Watchdog around startRecording. If Audio.Recording.createAsync hangs
 * (rare platform-edge case — file lock, audio session contention) the
 * spinner UI would otherwise be visible indefinitely. The 5s timeout
 * surfaces the same "Microphone unavailable" alert + router.back() path
 * the existing throw cases use.
 */
const START_RECORDING_TIMEOUT_MS = 5000

async function startRecordingWithTimeout(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('Microphone did not start in time')),
      START_RECORDING_TIMEOUT_MS,
    )
  })
  try {
    await Promise.race([startRecording(), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * One-shot fetch of the meeting's current server-side status, normalized
 * into the `MeetingProbeResult` shape decideMountAction consumes.
 * 'transcribing' / 'recording' → in-flight; anything else terminal;
 * 404 → 'gone'; any other error → 'unknown' (conservative re-attach).
 */
async function probeMeeting(meetingId: string): Promise<MeetingProbeResult> {
  try {
    const meeting = await fetchMeeting(meetingId)
    const s = meeting.status
    if (s === 'transcribing' || s === 'recording') return { kind: 'in-flight' }
    return { kind: 'terminal' }
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return { kind: 'gone' }
    return { kind: 'unknown' }
  }
}

export default function RecordScreen() {
  const status = useRecordingStore((s) => s.status)
  const startedAt = useRecordingStore((s) => s.startedAt)
  const uploadProgress = useRecordingStore((s) => s.uploadProgress)
  const error = useRecordingStore((s) => s.error)
  const reset = useRecordingStore((s) => s.reset)
  const userId = useAuthStore((s) => s.userId)

  // T5 — calendar-context entry point. When the user taps "Record" on a
  // scheduled meeting's detail screen, the route carries `calEventId` (and
  // `title` for display). On stop, we pass these into the upload so the
  // gateway's /recordings/upload find-or-update path lights up the
  // existing meeting row instead of inserting an impromptu one.
  const params = useLocalSearchParams<{ calEventId?: string; title?: string }>()
  const calEventId =
    typeof params.calEventId === 'string' && params.calEventId.length > 0
      ? params.calEventId
      : undefined
  const calendarTitle =
    typeof params.title === 'string' && params.title.length > 0
      ? params.title
      : undefined

  // Poll /meetings/:id every 10s while we're in 'transcribing'. Fires
  // markDone + navigates to meeting detail when the gateway flips status to
  // 'transcribed' or 'empty'. This is the working fallback for
  // "transcript ready" while we wait on the Apple Developer Program
  // approval needed for APNs push. When APNs lands, the notification
  // handler in _layout.tsx also navigates; first one to win owns the
  // transition (router.replace is idempotent).
  useTranscribingPoll()

  // pendingUpload is loaded asynchronously because loadPendingUploadOrEvict
  // does a filesystem deleteAsync for stale entries. Null = "no entry OR
  // entry evicted as too old". Undefined = "still loading on first render".
  const [pendingUpload, setPendingUpload] = useState<PendingUpload | null | undefined>(
    undefined,
  )

  // Mount-time dispatch. The actual decision logic lives in mount-action.ts
  // as a pure function so it can be unit-tested without a React renderer
  // (mirrors poll-action.ts). This useEffect just loads inputs, asks the
  // pure function what to do, and runs the side effects.
  useEffect(() => {
    if (!userId) return
    let cancelled = false
    void (async () => {
      const loaded = await loadMostRecentPendingUploadOrEvict(userId)
      if (cancelled) return
      setPendingUpload(loaded)

      // Probe the gateway only when we actually need it (idle + pending
      // with meetingId). Skipping the probe in other branches keeps cold-
      // start instant for the common case.
      let probe: MeetingProbeResult | undefined
      const currentStatus = useRecordingStore.getState().status
      if (currentStatus === 'idle' && loaded?.meetingId) {
        probe = await probeMeeting(loaded.meetingId)
        if (cancelled) return
      }

      const action = decideMountAction({
        storeStatus: currentStatus,
        pending: loaded,
        probe,
      })

      switch (action.kind) {
        case 'preserve':
          // Active local work in progress — leave alone.
          return
        case 'reset-and-start-fresh':
          useRecordingStore.getState().reset()
          await startFresh()
          return
        case 'start-fresh':
          await startFresh()
          return
        case 'reattach-poll':
          useRecordingStore.getState().finalizeMeeting(action.meetingId)
          return
        case 'discard-and-start-fresh':
          await discardPendingUploadFileById(action.clientRecordingId)
          if (cancelled) return
          setPendingUpload(null)
          await startFresh()
          return
        case 'show-retry-ui':
          useRecordingStore.getState().markError(
            action.pending.lastError ?? 'Previous upload failed — tap to retry.',
          )
          return
      }

      async function startFresh(): Promise<void> {
        try {
          await startRecordingWithTimeout()
        } catch (err) {
          Alert.alert(
            'Microphone unavailable',
            err instanceof Error ? err.message : 'Could not start recording',
          )
          router.back()
        }
      }
    })()
    return () => {
      cancelled = true
    }
    // Don't include status in deps — only re-run when userId becomes
    // available (post-hydrate). Mount-time decision is one-shot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId])

  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (status !== 'recording' || !startedAt) return
    const tick = () => setElapsed(Math.floor((Date.now() - startedAt) / 1000))
    tick()
    const handle = setInterval(tick, 1000)
    return () => clearInterval(handle)
  }, [status, startedAt])

  const onStop = async () => {
    try {
      // Prefer the calendar-event title when we arrived from a scheduled
      // meeting (T5). Otherwise generate a local-timezone fallback so the
      // gateway doesn't default to its UTC server-side title.
      const now = new Date()
      const title =
        calendarTitle ?? `Meeting ${now.toLocaleDateString()} ${now.toLocaleTimeString()}`
      await stopRecording({ title, ...(calEventId ? { calEventId } : {}) })
      // Stay on this screen showing the "Transcribing…" copy. The APNs push
      // (or a manual return) takes the user to /meetings/[id].
    } catch (err) {
      // store.markError() was already called; the UI will switch to the
      // error state. Nothing more to do here.
      console.warn('[record] stop failed:', err)
    }
  }

  const onDone = () => {
    reset()
    router.back()
  }

  const onCancel = async () => {
    await cancelRecording()
    router.back()
  }

  const onRetryUpload = async () => {
    if (!pendingUpload) return
    try {
      await retryPendingUpload(pendingUpload)
      // On success, store flips to 'transcribing'; useTranscribingPoll picks
      // it up and navigates. Clear local pendingUpload state so the next
      // mount auto-starts a fresh recording.
      setPendingUpload(null)
    } catch (err) {
      // markError already fired inside performUpload — UI shows the new
      // message; the pending blob is still in MMKV for another retry.
      console.warn('[record] retry upload failed:', err)
    }
  }

  const onDiscardPending = async () => {
    // The Discard button on the retry-UI is only visible when we have a
    // loaded pendingUpload (the surrounding render guards on truthy
    // pendingUpload), so the null-check below is defensive.
    if (pendingUpload) {
      await discardPendingUpload(pendingUpload.clientRecordingId)
      setPendingUpload(null)
    }
    reset()
    router.back()
  }

  const onStartFresh = async () => {
    reset()
    try {
      await startRecordingWithTimeout()
    } catch (err) {
      Alert.alert(
        'Microphone unavailable',
        err instanceof Error ? err.message : 'Could not restart recording',
      )
    }
  }

  // While loadPendingUploadOrEvict is running (one tick on cold-start, plus
  // any time we have a stale entry to delete), avoid flashing the
  // "fresh recording" UI. The useEffect drives the actual state transition
  // once pendingUpload resolves.
  if (pendingUpload === undefined) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <ActivityIndicator color={colors.crimson} />
        </View>
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView style={styles.container}>
      {status === 'idle' && (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.crimson} />
          <Text style={[styles.heading, { marginTop: spacing.md }]}>Starting…</Text>
          <Pressable onPress={onCancel} style={styles.cancelLink}>
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
        </View>
      )}

      {status === 'recording' && (
        <View style={styles.center}>
          <Text style={styles.heading}>Recording</Text>
          <Text style={styles.timer}>{formatElapsed(elapsed)}</Text>
          <Text style={styles.caption}>
            Tap Stop when the meeting ends. We'll transcribe and notify you when it's ready.
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Stop recording"
            onPress={onStop}
            style={({ pressed }) => [styles.stopButton, pressed && styles.pressed]}
          >
            <View style={styles.stopSquare} />
          </Pressable>
          <Pressable onPress={onCancel} style={styles.cancelLink}>
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
        </View>
      )}

      {status === 'uploading' && (
        <View style={styles.center}>
          <Text style={styles.heading}>Uploading…</Text>
          <View style={styles.progressBarTrack}>
            <View style={[styles.progressBarFill, { width: `${Math.round(uploadProgress * 100)}%` }]} />
          </View>
          <Text style={styles.caption}>{Math.round(uploadProgress * 100)}%</Text>
        </View>
      )}

      {status === 'transcribing' && (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.crimson} />
          <Text style={[styles.heading, { marginTop: spacing.md }]}>Transcribing…</Text>
          <Text style={styles.caption}>
            You'll get a notification when the transcript is ready. Feel free to close the app.
          </Text>
          <Pressable
            onPress={onDone}
            style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
          >
            <Text style={styles.secondaryText}>Done</Text>
          </Pressable>
        </View>
      )}

      {status === 'done' && (
        <View style={styles.center}>
          <Text style={styles.heading}>All set</Text>
          <Pressable
            onPress={onDone}
            style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
          >
            <Text style={styles.secondaryText}>Back to Calendar</Text>
          </Pressable>
        </View>
      )}

      {status === 'error' && pendingUpload && (
        <View style={styles.center}>
          <Text style={styles.heading}>Upload didn't finish</Text>
          <Text style={styles.caption}>
            {error ?? pendingUpload.lastError ?? 'Your recording is saved on this phone — tap to retry the upload.'}
          </Text>
          {pendingUpload.fileSizeBytes != null && (
            <Text style={styles.caption}>
              {formatBytes(pendingUpload.fileSizeBytes)} • recorded at{' '}
              {new Date(pendingUpload.clientRecordedAt).toLocaleTimeString()}
            </Text>
          )}
          <Pressable
            onPress={onRetryUpload}
            style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
          >
            <Text style={styles.secondaryText}>Retry upload</Text>
          </Pressable>
          <Pressable onPress={onDiscardPending} style={styles.cancelLink}>
            <Text style={styles.cancelText}>Discard recording</Text>
          </Pressable>
        </View>
      )}

      {status === 'error' && !pendingUpload && (
        <View style={styles.center}>
          <Text style={styles.heading}>Something went wrong</Text>
          <Text style={styles.caption}>{error ?? 'Please try again.'}</Text>
          <Pressable
            onPress={onStartFresh}
            style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
          >
            <Text style={styles.secondaryText}>Try again</Text>
          </Pressable>
          <Pressable onPress={onCancel} style={styles.cancelLink}>
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
        </View>
      )}
    </SafeAreaView>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatElapsed(seconds: number): string {
  const mm = Math.floor(seconds / 60)
    .toString()
    .padStart(2, '0')
  const ss = (seconds % 60).toString().padStart(2, '0')
  return `${mm}:${ss}`
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.lg,
  },
  heading: { fontSize: type.h1, fontWeight: '600', color: colors.text },
  timer: {
    fontSize: 56,
    fontVariant: ['tabular-nums'],
    fontWeight: '300',
    color: colors.text,
    marginTop: spacing.sm,
  },
  caption: {
    fontSize: type.body,
    color: colors.text3,
    textAlign: 'center',
    lineHeight: 20,
  },
  stopButton: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: colors.crimson,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.lg,
  },
  stopSquare: {
    width: 28,
    height: 28,
    borderRadius: 4,
    backgroundColor: colors.surface,
  },
  pressed: { opacity: 0.85 },
  secondaryButton: {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xl,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    marginTop: spacing.md,
  },
  secondaryText: { fontSize: type.body, color: colors.text, fontWeight: '600' },
  cancelLink: { marginTop: spacing.sm, padding: spacing.sm },
  cancelText: { fontSize: type.meta, color: colors.text3 },
  progressBarTrack: {
    width: '80%',
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.border,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: colors.crimson,
  },
})
