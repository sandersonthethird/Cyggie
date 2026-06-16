// =============================================================================
// start-impromptu.ts — the Record-tab entry point.
//
// Goal: opening an impromptu recording must feel INSTANT and work OFFLINE, and
// an accidental tap must be trivial to undo (Cancel deletes the row).
//
//   tap Record
//     ├─ guard: bail if a recording is already in flight (double-tap / re-entry)
//     ├─ mint client meetingId  (gateway-valid, on-device)
//     ├─ seed optimistic MeetingDetail into the TanStack cache  ──┐ instant
//     ├─ start the mic (local; throws → abort + clear optimistic) │ render,
//     ├─ router.push('/meetings/:id')  ── the meeting view IS the │ no fetch
//     │                                    recording surface       │
//     └─ fire createImpromptuMeeting() best-effort ────────────────┘
//          success → markMeetingConfirmed + replace optimistic w/ server row
//          failure → stay unconfirmed (offline). Notes buffer; the Stop-time
//                    upload create-if-absent confirms the row later.
// =============================================================================

import { Alert } from 'react-native'
import { router } from 'expo-router'
import type { QueryClient } from '@tanstack/react-query'
import { startRecording } from './session'
import { useRecordingStore } from './store'
import {
  buildOptimisticMeeting,
  generateClientMeetingId,
} from './optimistic-meeting'
import { markMeetingConfirmed } from './confirmed-meetings'
import { createImpromptuMeeting } from '../api/meetings'

function meetingDetailKey(id: string): [string, string, string] {
  return ['meetings', 'detail', id]
}

export async function startImpromptuRecording(queryClient: QueryClient): Promise<void> {
  // Re-entry / double-tap guard. RecordTabButton also has a 600ms guard and
  // startRecording throws "already in progress"; this is the first line.
  if (useRecordingStore.getState().status !== 'idle') return

  const id = generateClientMeetingId()
  const now = new Date()
  const clientRecordedAt = now.toISOString()
  const title = `Meeting ${now.toLocaleDateString()} ${now.toLocaleTimeString()}`

  // Seed the optimistic record BEFORE navigating so the meeting view renders
  // instantly with no network fetch (and survives offline 404s on its poll).
  queryClient.setQueryData(meetingDetailKey(id), buildOptimisticMeeting({ id, title, date: clientRecordedAt }))

  // Start the mic locally. On failure (permission denied, audio session busy)
  // abort cleanly — drop the optimistic record and don't navigate.
  try {
    await startRecording({ meetingId: id, title, discardOnCancel: true })
  } catch (err) {
    queryClient.removeQueries({ queryKey: meetingDetailKey(id) })
    Alert.alert(
      'Microphone unavailable',
      err instanceof Error ? err.message : 'Could not start recording',
    )
    return
  }

  // Open the meeting view immediately — recording is already running.
  router.push(`/meetings/${id}` as never)

  // Pre-create the gateway row in the background. Offline/5xx is fine: the row
  // gets created-if-absent at Stop-time upload, which also confirms it.
  void createImpromptuMeeting({ id, title, clientRecordedAt })
    .then((server) => {
      markMeetingConfirmed(server.id)
      queryClient.setQueryData(meetingDetailKey(id), server)
    })
    .catch(() => {
      // Stay unconfirmed; notes buffer in the draft until the upload confirms.
    })
}
