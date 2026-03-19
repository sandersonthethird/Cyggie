import { create } from 'zustand'
import type { TranscriptSegment } from '../../shared/types/recording'

type ChannelMode = 'detecting' | 'multichannel' | 'diarization'

interface RecordingState {
  isRecording: boolean
  isPaused: boolean
  meetingId: string | null
  meetingPlatform: string | null
  startTime: number | null
  duration: number
  liveTranscript: TranscriptSegment[]
  interimSegment: TranscriptSegment | null
  speakerCount: number
  channelMode: ChannelMode | null
  error: string | null
  // Tracks meetings that were stopped automatically (calendar end time / silence).
  // Hides "Continue Recording" for the session — resets on app restart.
  autoStoppedMeetingIds: Set<string>

  startRecording: (meetingId: string, meetingPlatform?: string | null) => void
  stopRecording: () => void
  pauseRecording: () => void
  resumeRecording: () => void
  addTranscriptSegment: (segment: TranscriptSegment) => void
  setInterimSegment: (segment: TranscriptSegment | null) => void
  setDuration: (duration: number) => void
  setSpeakerCount: (count: number) => void
  setChannelMode: (mode: ChannelMode | null) => void
  setError: (error: string | null) => void
  clearTranscript: () => void
  markAutoStopped: (meetingId: string) => void
}

export const useRecordingStore = create<RecordingState>((set) => ({
  isRecording: false,
  isPaused: false,
  meetingId: null,
  meetingPlatform: null,
  startTime: null,
  duration: 0,
  liveTranscript: [],
  interimSegment: null,
  speakerCount: 0,
  channelMode: null,
  error: null,
  autoStoppedMeetingIds: new Set<string>(),

  startRecording: (meetingId, meetingPlatform) =>
    set({
      isRecording: true,
      isPaused: false,
      meetingId,
      meetingPlatform: meetingPlatform || null,
      startTime: Date.now(),
      duration: 0,
      liveTranscript: [],
      interimSegment: null,
      speakerCount: 0,
      channelMode: null,
      error: null
    }),

  stopRecording: () =>
    set({
      isRecording: false,
      isPaused: false,
      meetingId: null,
      meetingPlatform: null,
      startTime: null,
      interimSegment: null,
      channelMode: null
    }),

  pauseRecording: () => set({ isPaused: true }),

  resumeRecording: () => set({ isPaused: false }),

  addTranscriptSegment: (segment) =>
    set((state) => ({
      liveTranscript: [...state.liveTranscript, segment]
    })),

  setInterimSegment: (segment) => set({ interimSegment: segment }),

  setDuration: (duration) => set({ duration }),

  setSpeakerCount: (count) => set({ speakerCount: count }),

  setChannelMode: (mode) => set({ channelMode: mode }),

  setError: (error) => set({ error }),

  clearTranscript: () =>
    set({
      liveTranscript: [],
      interimSegment: null
    }),

  markAutoStopped: (meetingId) =>
    set((state) => ({
      autoStoppedMeetingIds: new Set([...state.autoStoppedMeetingIds, meetingId])
    }))
}))
