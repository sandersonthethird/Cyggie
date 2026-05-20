// =============================================================================
// use-transcribing-poll.ts — APNs-independent fallback for "transcript ready".
//
// While the gateway's Deepgram batch job is in flight, the mobile client
// sits at status='transcribing'. The canonical "you're done" signal is the
// APNs push from the gateway — but that requires the Apple Developer Program
// + APNs auth key to be wired (operational paperwork that can take days).
//
// This hook gives us a working flow today: while the user is on the recording
// screen with status='transcribing', poll /meetings/:id every 10s. When the
// server flips to status='transcribed', auto-navigate to /meetings/[id]; on
// status='error', surface the error in the store.
//
//        ┌─ status='transcribing' ────────────────────────────────┐
//        │   useQuery(['meeting', id, 'poll'], refetchInterval 10s) │
//        │       │                                                 │
//        │       ▼                                                 │
//        │   data.status === 'transcribed'  → markDone +           │
//        │                                     router.replace      │
//        │   data.status === 'error'        → markError            │
//        │   else (still 'recording')       → wait next tick       │
//        └─────────────────────────────────────────────────────────┘
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
import { useRecordingStore } from './store'

export function useTranscribingPoll(): void {
  const status = useRecordingStore((s) => s.status)
  const meetingId = useRecordingStore((s) => s.meetingId)
  const markDone = useRecordingStore((s) => s.markDone)
  const markError = useRecordingStore((s) => s.markError)

  const { data } = useQuery({
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
    // Treat polling failures as transient — keep trying. A real failure ends
    // up either as data.status='error' or the user navigates away.
    retry: false,
  })

  useEffect(() => {
    if (status !== 'transcribing' || !data || !meetingId) return
    if (data.status === 'transcribed') {
      markDone()
      // replace() so the user can't hit Back into the recording screen and
      // see stale "Transcribing…" copy.
      router.replace(`/meetings/${meetingId}`)
    } else if (data.status === 'error') {
      markError('Transcription failed on the server')
    }
  }, [status, data, meetingId, markDone, markError])
}
