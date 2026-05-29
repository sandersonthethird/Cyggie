// Shared transcript post-processing.
//
// Two helpers used by both the live finalize path (RecordingSession) and the
// transcription-eval adapters, so an alternate provider's output gets the
// same speaker-labelling + proper-noun correction the live Deepgram pipeline
// applies. Without this, WER / side-by-side comparisons would be biased —
// Deepgram benefits from post-correction, others don't.
//
// Original homes:
//   - speaker map building: RecordingSession.ts:700-715
//   - markdown proper-noun correction: RecordingSession.ts:720-738

import { correctProperNouns } from '@main/utils/proper-noun-corrector'

export type ChannelMode = 'multichannel' | 'diarization' | 'detecting'

export interface SpeakerMapContext {
  channelMode: ChannelMode
  calendarSelfName: string | null
  calendarAttendees: string[]
}

/**
 * Map Deepgram speaker indices → display names.
 *
 *   Multichannel mode (stereo recording): channel 0 = mic → speaker 0 is
 *   reliably the recorder (selfName). Channel 1 carries system audio with
 *   everyone else; positional mapping of attendees to indices 1+ holds
 *   only when there's exactly one other speaker, but at minimum self is
 *   always correct.
 *
 *   Diarization (single-channel) mode: no audio-derived signal of who's
 *   who. Positional guessing here produced confidently-wrong labels
 *   (e.g. "Sandy" attributed to colleague "Andy" because Andy happened to
 *   come first in the attendee list). Fall back to neutral "Speaker N"
 *   labels and let the user relabel post-hoc.
 */
export function buildSpeakerMap(
  speakerIds: Iterable<number>,
  ctx: SpeakerMapContext,
): Record<number, string> {
  const map: Record<number, string> = {}
  if (ctx.channelMode === 'multichannel') {
    const allNames: string[] = []
    if (ctx.calendarSelfName || ctx.calendarAttendees.length > 0) {
      allNames.push(ctx.calendarSelfName || 'You')
      allNames.push(...ctx.calendarAttendees)
    }
    for (const id of speakerIds) {
      map[id] = allNames[id] || `Speaker ${id + 1}`
    }
  } else {
    for (const id of speakerIds) {
      map[id] = `Speaker ${id + 1}`
    }
  }
  return map
}

/**
 * Apply CRM-driven proper noun correction to a transcript markdown body,
 * skipping speaker header lines so timestamps don't get mangled.
 *
 * Header lines have the shape `**Speaker N** [00:00] body...`. We skip any
 * line that starts with `**` and contains `** [` because the bracketed
 * timestamp would otherwise be a fuzzy-match target for short names.
 */
export function correctTranscriptMarkdown(
  rawTranscriptMd: string,
  crmNames: string[],
): string {
  if (crmNames.length === 0) return rawTranscriptMd
  const lines = rawTranscriptMd.split('\n')
  return lines
    .map((line) =>
      line.startsWith('**') && line.includes('** [')
        ? line
        : correctProperNouns(line, crmNames),
    )
    .join('\n')
}
