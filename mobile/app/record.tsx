// =============================================================================
// record.tsx — recording UI route.
//
// State-driven by useRecordingStore:
//
//   idle          → unexpected (we navigate in via tap-FAB → startRecording);
//                   show a Start button as a safety net so the user isn't stuck.
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
import { router } from 'expo-router'
import {
  cancelRecording,
  discardPendingUpload,
  retryPendingUpload,
  startRecording,
  stopRecording,
} from '../lib/recording/session'
import {
  discardPendingUploadFile,
  loadPendingUploadOrEvict,
  type PendingUpload,
} from '../lib/recording/pending-upload'
import { useRecordingStore } from '../lib/recording/store'
import { useTranscribingPoll } from '../lib/recording/use-transcribing-poll'
import { fetchMeeting } from '../lib/api/meetings'
import { ApiError } from '../lib/api/client'
import { colors, radii, spacing, type } from '../theme'

export default function RecordScreen() {
  const status = useRecordingStore((s) => s.status)
  const startedAt = useRecordingStore((s) => s.startedAt)
  const uploadProgress = useRecordingStore((s) => s.uploadProgress)
  const error = useRecordingStore((s) => s.error)
  const reset = useRecordingStore((s) => s.reset)

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

  // Mount-time decision tree. Principle: tap Record FAB = "I want to record
  // now". Honor that intent unless there's literally an active local-side
  // operation we can't interrupt.
  //
  // Store-state handling:
  //   • 'recording' / 'uploading' — active local work; don't disturb.
  //     (Effectively unreachable from a FAB tap — calendar UI is hidden
  //     behind /record when mounted — but safe to early-return.)
  //   • 'transcribing' — leftover poll from a previous session the user
  //     backed out of. Server-side transcription completes regardless;
  //     the meeting will appear in the calendar list when done. We reset
  //     locally + discard the MMKV pendingUpload (losing retry-upload
  //     safety net for that older recording) so the user can start fresh.
  //     We never tell the gateway to cancel — there's no such API; the
  //     in-flight job runs to completion server-side.
  //   • 'done' / 'error' — terminal from a previous session that never
  //     got cleaned up. Reset + start fresh.
  //   • 'idle' — fresh visit. Check MMKV for a stale entry to either
  //     re-attach (in-flight elsewhere) or treat as awaiting_upload retry.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const loaded = await loadPendingUploadOrEvict()
      if (cancelled) return
      setPendingUpload(loaded)
      const currentStatus = useRecordingStore.getState().status
      if (currentStatus === 'recording' || currentStatus === 'uploading') {
        // Active local-side operation — don't interrupt.
        return
      }
      if (currentStatus !== 'idle') {
        // Leftover non-idle state from a previous session (transcribing /
        // done / error). User tapped Record FAB → background the old,
        // start fresh. Server-side state is untouched; any in-flight
        // transcription will appear in the calendar list when it completes.
        if (loaded) {
          await discardPendingUploadFile()
          if (cancelled) return
          setPendingUpload(null)
        }
        useRecordingStore.getState().reset()
        try {
          await startRecording()
        } catch (err) {
          Alert.alert(
            'Microphone unavailable',
            err instanceof Error ? err.message : 'Could not start recording',
          )
          router.back()
        }
        return
      }
      if (loaded?.meetingId) {
        // Stale meetingId in MMKV: it might be a genuinely in-flight
        // transcription the user wants to re-attach to (force-quit
        // mid-transcription, reopening via Record FAB), OR it might be
        // a meeting that already terminated (transcribed/empty/error/404)
        // but never got cleaned up because the poll wasn't running when
        // the webhook fired. Distinguish via a one-shot fetch — re-attach
        // only for actually-in-flight; silently clean up + start fresh
        // for terminal cases. Tapping Record FAB should not navigate to
        // an old finished meeting.
        let inFlight = false
        try {
          const meeting = await fetchMeeting(loaded.meetingId)
          if (cancelled) return
          inFlight = meeting.status === 'transcribing' || meeting.status === 'recording'
        } catch (err) {
          if (err instanceof ApiError && err.status === 404) {
            // Server-side deleted; treat as terminal.
            inFlight = false
          } else {
            // Network blip — be conservative and re-attach so we don't
            // accidentally clean up an in-flight job we can't reach.
            inFlight = true
          }
        }
        if (cancelled) return
        if (inFlight) {
          useRecordingStore.getState().finalizeMeeting(loaded.meetingId)
          return
        }
        // Terminal — silently clean up and fall through to startRecording
        await discardPendingUploadFile()
        if (cancelled) return
        setPendingUpload(null)
      } else if (loaded) {
        // awaiting_upload (failed previous upload, no meetingId) → error UI
        // with the retry banner.
        useRecordingStore.getState().markError(
          loaded.lastError ?? 'Previous upload failed — tap to retry.',
        )
        return
      }
      try {
        await startRecording()
      } catch (err) {
        Alert.alert(
          'Microphone unavailable',
          err instanceof Error ? err.message : 'Could not start recording',
        )
        router.back()
      }
    })()
    return () => {
      cancelled = true
    }
    // Don't include status in deps — only run on initial mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
      await stopRecording({})
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
    await discardPendingUpload()
    setPendingUpload(null)
    reset()
    router.back()
  }

  const onStartFresh = async () => {
    reset()
    try {
      await startRecording()
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
      {(status === 'idle' || status === 'recording') && (
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
