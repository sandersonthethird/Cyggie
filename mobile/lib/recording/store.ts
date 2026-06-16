// =============================================================================
// recording/store.ts — Zustand state for the M3 recording flow.
//
// State machine:
//
//   idle ──[startRecording]──▶ recording ──[stopRecording]──▶ uploading
//                                  │                             │
//                                  │                             ├─ ok ─▶ transcribing ──[push received]──▶ done
//                                  │                             │
//                                  └─[error]─▶ error             └─[upload err]─▶ error
//
// The `transcribing` state has no client-side timeout — the gateway pushes
// when Deepgram finishes. Mobile shows "Transcribing… we'll notify you."
// UI; the user can leave the screen. When the APNs notification arrives,
// the root layout handler taps into /meetings/[id] directly.
// =============================================================================

import { create } from 'zustand'

export type RecordingStatus =
  | 'idle'
  | 'recording'
  | 'uploading'
  | 'transcribing'
  | 'done'
  | 'error'

/** Context handed to beginRecording — the meeting this session records into.
 *  meetingId is now known at START (client-minted for impromptu, the existing
 *  row id for scheduled), not just post-upload. */
export interface BeginRecordingContext {
  meetingId: string
  title: string
  calEventId?: string
  /** True for impromptu pre-created rows: Cancel should delete the gateway row.
   *  False for scheduled meetings: Cancel just stops the mic (the row predates us). */
  discardOnCancel: boolean
}

interface RecordingState {
  status: RecordingStatus
  /** Set once stopRecording resolves and the gateway returns the new meetingId. */
  meetingId: string | null
  /** The meeting being recorded into — set at START. The meeting view + bubble
   *  gate their live-recording UI on `status==='recording' && activeMeetingId===id`
   *  (never on the server status string). */
  activeMeetingId: string | null
  /** Display title for the bubble ("<title> · tap to view"). */
  activeTitle: string | null
  /** Whether Cancel should delete the gateway row (impromptu) or not (scheduled). */
  discardOnCancel: boolean
  /** Set on recording start (ms epoch). UI computes elapsed off this. */
  startedAt: number | null
  /** 0–1, surfaced by expo-file-system's upload progress callback. */
  uploadProgress: number
  /** Human-readable error surface for the UI. */
  error: string | null
  // Actions —
  beginRecording: (ctx: BeginRecordingContext) => void
  beginUploading: () => void
  setUploadProgress: (p: number) => void
  finalizeMeeting: (meetingId: string) => void
  markDone: () => void
  markError: (message: string) => void
  reset: () => void
}

const INITIAL: Omit<
  RecordingState,
  'beginRecording' | 'beginUploading' | 'setUploadProgress' | 'finalizeMeeting' | 'markDone' | 'markError' | 'reset'
> = {
  status: 'idle',
  meetingId: null,
  activeMeetingId: null,
  activeTitle: null,
  discardOnCancel: false,
  startedAt: null,
  uploadProgress: 0,
  error: null,
}

export const useRecordingStore = create<RecordingState>((set) => ({
  ...INITIAL,
  beginRecording: (ctx) =>
    set({
      status: 'recording',
      meetingId: ctx.meetingId,
      activeMeetingId: ctx.meetingId,
      activeTitle: ctx.title,
      discardOnCancel: ctx.discardOnCancel,
      startedAt: Date.now(),
      uploadProgress: 0,
      error: null,
    }),
  beginUploading: () => set({ status: 'uploading', uploadProgress: 0 }),
  setUploadProgress: (p) => set({ uploadProgress: Math.max(0, Math.min(1, p)) }),
  finalizeMeeting: (meetingId) =>
    set({ status: 'transcribing', meetingId, uploadProgress: 1 }),
  markDone: () => set({ status: 'done' }),
  markError: (message) => set({ status: 'error', error: message }),
  reset: () => set(INITIAL),
}))
