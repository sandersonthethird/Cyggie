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
//     ├─ recording.stopAndUnloadAsync()
//     ├─ store.beginUploading()
//     ├─ uploadRecording({ localUri, onProgress: store.setUploadProgress })
//     ├─ store.finalizeMeeting(meetingId)   ← state = 'transcribing'
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
import { useRecordingStore } from './store'

let activeRecording: Audio.Recording | null = null
let recordingStartedAt: Date | null = null

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

  await recording.stopAndUnloadAsync()
  const localUri = recording.getURI()
  if (!localUri) {
    useRecordingStore.getState().markError('Recording produced no audio file')
    throw new Error('Recording produced no audio file')
  }

  useRecordingStore.getState().beginUploading()
  try {
    const result = await uploadRecording({
      localUri,
      title: args.title,
      calEventId: args.calEventId,
      clientRecordedAt: startedAt?.toISOString(),
      onProgress: (p) => useRecordingStore.getState().setUploadProgress(p),
    })
    useRecordingStore.getState().finalizeMeeting(result.meetingId)
    // Best-effort cleanup. The gateway has the audio now; phone copy is
    // disposable. Failure here is non-fatal (cache will get GC'd by iOS).
    void FileSystem.deleteAsync(localUri, { idempotent: true }).catch(() => {})
    return { meetingId: result.meetingId }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Upload failed'
    useRecordingStore.getState().markError(message)
    // Keep the local file around for a future retry — Slice 3 polish wires
    // the explicit "Retry upload" UI to this same file.
    throw err
  }
}

/** Safe cleanup if the user backs out of the recording screen without stopping. */
export async function cancelRecording(): Promise<void> {
  const recording = activeRecording
  activeRecording = null
  recordingStartedAt = null
  if (!recording) return
  try {
    await recording.stopAndUnloadAsync()
    const uri = recording.getURI()
    if (uri) await FileSystem.deleteAsync(uri, { idempotent: true })
  } catch {
    // best-effort
  }
  useRecordingStore.getState().reset()
}
