// Deepgram batch utterance → canonical TranscriptSegment mapping.
//
// The shape Deepgram returns for prerecorded /v1/listen utterances differs
// from the canonical TranscriptSegment shape the rest of the app expects.
// Extracting the mapping here keeps gateway and desktop in lock-step.
//
// Original home: api-gateway/src/recording/transcribe-job.ts:559-601
// (extractSegments). The cathedral-build E2E on 2026-05-21 surfaced a silent
// failure mode where missing this mapping flips meetings to status='transcribed'
// but the detail screen shows "No transcript" — the comment in the original
// extractSegments explains the discovery in more detail.

import type { TranscriptSegment } from '@shared/types/recording'

export interface DeepgramWord {
  word: string
  start: number
  end: number
  confidence: number
  speaker?: number
  punctuated_word?: string
}

export interface DeepgramUtterance {
  start: number
  end: number
  confidence: number
  channel: number
  transcript: string
  words: DeepgramWord[]
  speaker?: number
}

export interface DeepgramBatchResult {
  metadata?: {
    request_id?: string
    duration?: number
    channels?: number
  }
  results: {
    channels: Array<{
      alternatives: Array<{
        transcript: string
        words: DeepgramWord[]
      }>
    }>
    utterances?: DeepgramUtterance[]
  }
}

export function mapDeepgramUtterancesToSegments(
  payload: DeepgramBatchResult,
): TranscriptSegment[] {
  const utterances = payload.results.utterances ?? []
  const out: TranscriptSegment[] = []
  for (const u of utterances) {
    if (
      typeof u.speaker !== 'number' ||
      typeof u.transcript !== 'string' ||
      typeof u.start !== 'number' ||
      typeof u.end !== 'number'
    ) {
      continue
    }
    out.push({
      speaker: u.speaker,
      text: u.transcript,
      startTime: u.start,
      endTime: u.end,
      isFinal: true,
    })
  }
  return out
}

export function buildGenericSpeakerMap(
  payload: DeepgramBatchResult,
): Record<number, string> {
  const speakerIds = new Set<number>()
  for (const utt of payload.results.utterances ?? []) {
    if (typeof utt.speaker === 'number') speakerIds.add(utt.speaker)
  }
  const map: Record<number, string> = {}
  for (const id of speakerIds) map[id] = `Speaker ${id + 1}`
  return map
}
