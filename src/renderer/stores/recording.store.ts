import { create } from 'zustand'
import type { TranscriptSegment } from '../../shared/types/recording'

interface RecordingState {
  isRecording: boolean
  isPaused: boolean
  meetingId: string | null
  startTime: number | null
  duration: number
  liveTranscript: TranscriptSegment[]
  interimSegment: TranscriptSegment | null
  speakerCount: number
  error: string | null

  startRecording: (meetingId: string) => void
  stopRecording: () => void
  pauseRecording: () => void
  resumeRecording: () => void
  addTranscriptSegment: (segment: TranscriptSegment) => void
  setInterimSegment: (segment: TranscriptSegment | null) => void
  setDuration: (duration: number) => void
  setSpeakerCount: (count: number) => void
  setError: (error: string | null) => void
  clearTranscript: () => void
}

export const useRecordingStore = create<RecordingState>((set) => ({
  isRecording: false,
  isPaused: false,
  meetingId: null,
  startTime: null,
  duration: 0,
  liveTranscript: [],
  interimSegment: null,
  speakerCount: 0,
  error: null,

  startRecording: (meetingId) =>
    set({
      isRecording: true,
      isPaused: false,
      meetingId,
      startTime: Date.now(),
      duration: 0,
      liveTranscript: [],
      interimSegment: null,
      speakerCount: 0,
      error: null
    }),

  stopRecording: () =>
    set({
      isRecording: false,
      isPaused: false,
      meetingId: null,
      startTime: null,
      interimSegment: null
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

  setError: (error) => set({ error }),

  clearTranscript: () =>
    set({
      liveTranscript: [],
      interimSegment: null
    })
}))
