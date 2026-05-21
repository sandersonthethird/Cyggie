// =============================================================================
// session.ts — phone-side recording orchestrator.
//
// Lifecycle:
//
//   startRecording()
//     ├─ Request mic permission (idempotent if already granted)
//     ├─ Audio.setAudioModeAsync({ allowsRecordingIOS: true, … })
//     ├─ Audio.Recording.createAsync({ AAC 16kHz mono })
//     └─ store.beginRecording()
//
//   stopRecording()
//     ├─ recording.stopAndUnloadAsync()  (on throw → store.markError)
//     └─ performUpload({ localUri, … })
//
//   performUpload() — shared by stopRecording + retryPendingUpload
//     ├─ store.beginUploading()           ← state = 'uploading'
//     ├─ uploadRecording({ localUri, onProgress: store.setUploadProgress })
//     ├─ store.finalizeMeeting(meetingId) ← state = 'transcribing'
//     └─ return { meetingId }
//
// We don't clean up the local audio file until after upload acks; that way
// if the user kills the app mid-upload the file is recoverable on next open.
// (Slice 3 polish will add the actual "retry upload" UI for that path.)
// =============================================================================

import { Audio } from 'expo-av'
// Legacy API path — see api/recordings.ts for the v19 migration note.
import * as FileSystem from 'expo-file-system/legacy'
import { uploadRecording } from '../api/recordings'
import {
  clearPendingUpload,
  savePendingUpload,
  type PendingUpload,
} from './pending-upload'
import { useRecordingStore } from './store'

let activeRecording: Audio.Recording | null = null
let recordingStartedAt: Date | null = null
let maxDurationTimer: ReturnType<typeof setTimeout> | null = null

// Hard cap on a single recording. 8 hours is the spec'd limit + aligns with
// the gateway's RECORDING_MAX_UPLOAD_BYTES default (200 MB ≈ 8hr of 32 kbps
// AAC). Past this point we auto-stop + upload so the user doesn't lose
// everything to an oversize-rejection.
const MAX_RECORDING_MS = 8 * 60 * 60 * 1000

/**
 * AAC 16kHz mono — small enough for sane uploads (1hr ≈ 14 MB) while preserving
 * speech intelligibility. Deepgram batch handles AAC natively.
 */
const RECORDING_OPTIONS: Audio.RecordingOptions = {
  isMeteringEnabled: false,
  android: {
    extension: '.m4a',
    outputFormat: Audio.AndroidOutputFormat.MPEG_4,
    audioEncoder: Audio.AndroidAudioEncoder.AAC,
    sampleRate: 16000,
    numberOfChannels: 1,
    bitRate: 32000,
  },
  ios: {
    extension: '.m4a',
    outputFormat: Audio.IOSOutputFormat.MPEG4AAC,
    audioQuality: Audio.IOSAudioQuality.MEDIUM,
    sampleRate: 16000,
    numberOfChannels: 1,
    bitRate: 32000,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  web: {
    mimeType: 'audio/webm',
    bitsPerSecond: 32000,
  },
}

export async function startRecording(): Promise<void> {
  if (activeRecording) {
    throw new Error('Recording already in progress')
  }

  // Request mic permission. Throws if user denies — caller should surface a
  // permission-denied screen.
  const perm = await Audio.requestPermissionsAsync()
  if (!perm.granted) {
    throw new Error('Microphone permission denied')
  }

  // iOS audio session config — required for recording to work and to survive
  // backgrounding (UIBackgroundModes:audio in app.config.ts).
  await Audio.setAudioModeAsync({
    allowsRecordingIOS: true,
    playsInSilentModeIOS: true,
    staysActiveInBackground: true,
    shouldDuckAndroid: true,
    interruptionModeAndroid: 1, // DO_NOT_MIX
    interruptionModeIOS: 1, // DO_NOT_MIX
    playThroughEarpieceAndroid: false,
  })

  const { recording } = await Audio.Recording.createAsync(RECORDING_OPTIONS)
  activeRecording = recording
  recordingStartedAt = new Date()
  useRecordingStore.getState().beginRecording()

  // Auto-stop at the 8hr cap. Fire-and-forget — if the user already stopped
  // by then, the timer no-ops via the activeRecording null check inside.
  maxDurationTimer = setTimeout(() => {
    if (activeRecording) {
      console.warn('[recording] 8hr cap hit — auto-stopping')
      void stopRecording({})
    }
  }, MAX_RECORDING_MS)
}

export async function stopRecording(args: {
  title?: string
  calEventId?: string
}): Promise<{ meetingId: string }> {
  const recording = activeRecording
  if (!recording) {
    throw new Error('Not recording')
  }
  activeRecording = null
  const startedAt = recordingStartedAt
  recordingStartedAt = null
  if (maxDurationTimer) {
    clearTimeout(maxDurationTimer)
    maxDurationTimer = null
  }

  try {
    await recording.stopAndUnloadAsync()
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to stop recording'
    useRecordingStore.getState().markError(msg)
    throw err
  }
  const localUri = recording.getURI()
  if (!localUri) {
    useRecordingStore.getState().markError('Recording produced no audio file')
    throw new Error('Recording produced no audio file')
  }

  const recordedAtIso = startedAt?.toISOString() ?? new Date().toISOString()

  return performUpload({
    localUri,
    title: args.title,
    calEventId: args.calEventId,
    clientRecordedAt: recordedAtIso,
  })
}

/**
 * Retry a previously-failed upload. Caller passes the PendingUpload loaded
 * from MMKV (typically the error-state UI in record.tsx).
 */
export async function retryPendingUpload(p: PendingUpload): Promise<{ meetingId: string }> {
  // Verify the local file still exists. iOS can evict tmp dir contents under
  // memory pressure (rare for AAC; documenting the guard for sanity).
  const info = await FileSystem.getInfoAsync(p.localUri)
  if (!info.exists) {
    clearPendingUpload()
    useRecordingStore.getState().markError(
      'The recording file is no longer available — please record again.',
    )
    throw new Error('Local audio file missing')
  }
  return performUpload(p)
}

/**
 * Shared upload path used by both fresh stop() and retry(). On success,
 * stores the server-assigned meetingId in the pending entry and KEEPS the
 * local audio file (cleanup happens later when the poll detects a terminal
 * status). On error, persists the pending-upload metadata so the user can
 * retry after an app restart.
 *
 * Why keep the file post-upload: if Deepgram's callback later sets
 * status='error', mobile can re-upload from the local copy rather than
 * losing the recording. See use-transcribing-poll.ts for the cleanup +
 * retry-promotion paths.
 */
async function performUpload(p: PendingUpload): Promise<{ meetingId: string }> {
  useRecordingStore.getState().beginUploading()
  try {
    const result = await uploadRecording({
      localUri: p.localUri,
      title: p.title,
      calEventId: p.calEventId,
      clientRecordedAt: p.clientRecordedAt,
      onProgress: (frac) => useRecordingStore.getState().setUploadProgress(frac),
    })
    useRecordingStore.getState().finalizeMeeting(result.meetingId)
    // Transition the pending entry from awaiting_upload → awaiting_transcription
    // by stamping it with the server-assigned meetingId. Audio file stays put.
    savePendingUpload({ ...p, meetingId: result.meetingId, lastError: undefined })
    return { meetingId: result.meetingId }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Upload failed'
    // Stash the metadata so the user can retry after an app restart. Best-
    // effort fileSize so the UI can show "you have a 4 MB unsent recording".
    let fileSizeBytes: number | undefined
    try {
      const info = await FileSystem.getInfoAsync(p.localUri)
      if (info.exists && 'size' in info && typeof info.size === 'number') {
        fileSizeBytes = info.size
      }
    } catch {
      // ignore — file size is cosmetic
    }
    savePendingUpload({ ...p, fileSizeBytes, lastError: message, meetingId: undefined })
    useRecordingStore.getState().markError(message)
    throw err
  }
}

/** Discard the persisted pending upload (delete the local file too).
 *  Thin re-export so the record.tsx Discard action keeps importing from
 *  ./session; the canonical implementation lives in pending-upload.ts. */
export { discardPendingUploadFile as discardPendingUpload } from './pending-upload'

/** Safe cleanup if the user backs out of the recording screen without stopping. */
export async function cancelRecording(): Promise<void> {
  const recording = activeRecording
  activeRecording = null
  recordingStartedAt = null
  if (maxDurationTimer) {
    clearTimeout(maxDurationTimer)
    maxDurationTimer = null
  }
  if (recording) {
    try {
      await recording.stopAndUnloadAsync()
      const uri = recording.getURI()
      if (uri) await FileSystem.deleteAsync(uri, { idempotent: true })
    } catch {
      // best-effort
    }
  }
  useRecordingStore.getState().reset()
}
