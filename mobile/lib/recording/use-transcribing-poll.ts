// =============================================================================
// use-transcribing-poll.ts — APNs-independent fallback for transcript-ready.
//
// While the gateway's Deepgram batch job is in flight, the mobile client
// sits at status='transcribing'. The canonical "you're done" signal is the
// APNs push from the gateway — but that requires the Apple Developer Program
// + APNs auth key to be wired (operational paperwork that can take days).
//
// This hook gives us a working flow today: while the user is on the
// recording screen with status='transcribing', poll /meetings/:id every 10s.
// When the server flips to a terminal status, react accordingly:
//
//        ┌─ status='transcribing' ─────────────────────────────────────────┐
//        │   useQuery(['meeting', id, 'poll'], refetchInterval 10s)        │
//        │       │                                                         │
//        │       ▼                                                         │
//        │   data.status === 'transcribed'                                 │
//        │     → discardByMeetingId + markDone + router.replace(/meetings)  │
//        │   data.status === 'empty'                                       │
//        │     → same cleanup; meeting detail shows "no speech" banner     │
//        │   data.status === 'error' AND updated_at < 30min ago            │
//        │     → markError(message)  (KEEP MMKV; existing retry UI fires)  │
//        │   data.status === 'error' AND updated_at >= 30min ago           │
//        │     → cleanup + markError("too old to retry")                   │
//        │   fetch throws 404                                              │
//        │     → cleanup + back to calendar (meeting was deleted)          │
//        │   else (still 'recording'/'transcribing') → wait next tick      │
//        └──────────────────────────────────────────────────────────────── ┘
//
// Cleanup = FileSystem.deleteAsync(pendingUpload.localUri) +
//           clearPendingUpload() (MMKV) — see `discardPendingUploadFileByMeetingId(meetingId)` below.
//           Idempotent / safe to call when the pending entry is already gone.
//
// The status-mapping decision is extracted into the pure function
// `decidePollAction` so it can be unit-tested without a React hook harness.
//
// When APNs is wired and a push fires, the notification tap handler in
// _layout.tsx also navigates to /meetings/[id] — the two paths converge.
// First one to fire wins. (Polling is throttled to 10s and only runs when
// the user is on the record screen, so it's cheap.)
// =============================================================================

import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { router } from 'expo-router'
import { fetchMeeting } from '../api/meetings'
import { useAuthStore } from '../auth/store'
import { useRecordingStore } from './store'
import { discardPendingUploadFileByMeetingId } from './pending-upload'
import { decidePollAction } from './poll-action'

export function useTranscribingPoll(): void {
  const status = useRecordingStore((s) => s.status)
  const meetingId = useRecordingStore((s) => s.meetingId)
  const markDone = useRecordingStore((s) => s.markDone)
  const markError = useRecordingStore((s) => s.markError)
  const userId = useAuthStore((s) => s.userId)

  const { data, error } = useQuery({
    queryKey: ['meeting', meetingId, 'transcribing-poll'],
    queryFn: ({ signal }) => fetchMeeting(meetingId!, { signal }),
    enabled: status === 'transcribing' && !!meetingId,
    // 10s gives the gateway + Deepgram a steady cadence without flooding it.
    // Deepgram batch typically returns in 20-60s for short meetings; the user
    // sees the result within one tick after completion.
    refetchInterval: 10_000,
    // Don't burn battery polling when the app is backgrounded. iOS suspends
    // the JS runtime anyway; this just prevents the wakeup race on resume.
    refetchIntervalInBackground: false,
    // Surface 404s (meeting deleted server-side) as a one-shot error rather
    // than retrying forever. Network blips still resolve via the next
    // refetchInterval tick.
    retry: false,
  })

  useEffect(() => {
    if (status !== 'transcribing' || !meetingId) return
    if (!userId) return
    const action = decidePollAction({ data, error, nowMs: Date.now() })
    switch (action.kind) {
      case 'noop':
        return
      case 'terminal-transcribed':
      case 'terminal-empty':
        // Both terminal-success paths: file + MMKV cleaned up, navigate to
        // meeting detail. The detail screen surfaces an "empty" banner if
        // status='empty' so the user can discard the silent recording.
        void discardPendingUploadFileByMeetingId(meetingId, userId).then(() => {
          markDone()
          // replace() so the user can't hit Back into the recording screen
          // and see stale "Transcribing…" copy.
          router.replace(`/meetings/${meetingId}`)
        })
        return
      case 'error-retryable':
        // Transient error — leave MMKV intact so the record.tsx error-state
        // (with pendingUpload present) renders the Retry button.
        markError(action.message)
        return
      case 'error-stale':
        // Stale-sweeper or otherwise too old to retry — clean up and surface
        // a terminal message. The record.tsx error state without pendingUpload
        // shows a generic "Try again" / "Cancel" pair; user will hit Cancel.
        void discardPendingUploadFileByMeetingId(meetingId, userId).then(() => {
          markError(action.message)
        })
        return
      case 'gone':
        void discardPendingUploadFileByMeetingId(meetingId, userId).then(() => {
          markError(action.message)
          router.replace('/(tabs)/calendar')
        })
        return
    }
  }, [status, data, error, meetingId, markDone, markError, userId])
}
