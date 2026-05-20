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
import { loadPendingUpload } from '../lib/recording/pending-upload'
import { useRecordingStore } from '../lib/recording/store'
import { useTranscribingPoll } from '../lib/recording/use-transcribing-poll'
import { colors, radii, spacing, type } from '../theme'

export default function RecordScreen() {
  const status = useRecordingStore((s) => s.status)
  const startedAt = useRecordingStore((s) => s.startedAt)
  const uploadProgress = useRecordingStore((s) => s.uploadProgress)
  const error = useRecordingStore((s) => s.error)
  const reset = useRecordingStore((s) => s.reset)

  // Poll /meetings/:id every 10s while we're in 'transcribing'. Fires
  // markDone + navigates to meeting detail when the gateway flips status to
  // 'transcribed'. This is the working fallback for "transcript ready" while
  // we wait on the Apple Developer Program approval needed for APNs push.
  // When APNs lands, the notification handler in _layout.tsx also navigates;
  // first one to win owns the transition (router.replace is idempotent).
  useTranscribingPoll()

  const [pendingUpload, setPendingUpload] = useState(() => loadPendingUpload())

  // Auto-start when arriving fresh from the Record FAB — unless there's a
  // pending failed upload waiting to be retried. In that case we land on the
  // error state and let the user choose Retry / Discard.
  useEffect(() => {
    if (status !== 'idle') return
    if (pendingUpload) {
      useRecordingStore.getState().markError(
        pendingUpload.lastError ?? 'Previous upload failed — tap to retry.',
      )
      return
    }
    startRecording().catch((err) => {
      Alert.alert(
        'Microphone unavailable',
        err instanceof Error ? err.message : 'Could not start recording',
      )
      router.back()
    })
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
