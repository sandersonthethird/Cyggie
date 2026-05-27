// useCombinedSpeakerPicker — adapter hook that lets EntityPicker render
// two sources at once: the meeting's calendar attendees (synchronous,
// in-memory) and the user's CRM contacts (IPC-backed via usePicker).
//
// Why a wrapper instead of touching EntityPicker:
//
//   EntityPicker (existing — unchanged)
//     ├── picker: PickerState<T>            ← we feed it this
//     ├── outside-click + listbox nav      ← reused as-is
//     └── debounced search                 ← reused as-is
//
//   useCombinedSpeakerPicker (this file)
//     ├── usePicker<ContactSummary>(CONTACT_LIST)
//     ├── client-side attendee filter
//     └── merge → PickerState<SpeakerCandidate>
//
// The merge order is attendees-then-contacts so the user sees the names
// they recognise from the calendar invite first, and CRM matches second.
//
// Attendee ids are synthesised as `attendee:<name>` — within a single
// meeting these are unique enough for React keys + listbox nav, and the
// `attendee:` prefix guarantees no collision with real contact ids.

import { useCallback, useMemo, useRef, useState } from 'react'
import type { ContactSummary } from '../../shared/types/contact'
import type { PickerState } from './usePicker'
import { usePicker } from './usePicker'
import { IPC_CHANNELS } from '../../shared/constants/channels'

// `isSectionLead` is true for the FIRST attendee and the FIRST contact in
// the merged results. The picker UI uses it to emit a section header
// ("Attendees" / "Contacts") above that item. Computing it in the hook
// instead of via closure-tracking in the renderItem prop keeps things
// stable across EntityPicker re-renders (the closure approach broke
// because EntityPicker reuses the same renderItem reference across
// renders, so a mutable prevKind variable would leak state).
export type SpeakerCandidate =
  | { id: string; kind: 'attendee'; name: string; isSectionLead: boolean }
  | { id: string; kind: 'contact'; contact: ContactSummary; isSectionLead: boolean }

export function useCombinedSpeakerPicker(attendees: string[]): PickerState<SpeakerCandidate> {
  const contactPicker = usePicker<ContactSummary>(IPC_CHANNELS.CONTACT_LIST)
  const [query, setQuery] = useState('')

  // Stable reference to the latest attendees array — used inside the
  // memoized search callback without forcing a new closure every render.
  const attendeesRef = useRef(attendees)
  attendeesRef.current = attendees

  const search = useCallback(
    (q: string, delay?: number) => {
      setQuery(q)
      contactPicker.search(q, delay)
    },
    [contactPicker],
  )

  const results = useMemo<SpeakerCandidate[]>(() => {
    const needle = query.trim().toLowerCase()
    const filteredAttendees = needle
      ? attendees.filter((a) => a.toLowerCase().includes(needle))
      : attendees
    const attendeeCandidates: SpeakerCandidate[] = filteredAttendees.map((name, idx) => ({
      id: `attendee:${name}`,
      kind: 'attendee',
      name,
      isSectionLead: idx === 0,
    }))
    const contactCandidates: SpeakerCandidate[] = contactPicker.results.map((c, idx) => ({
      id: c.id,
      kind: 'contact',
      contact: c,
      isSectionLead: idx === 0,
    }))
    return [...attendeeCandidates, ...contactCandidates]
  }, [attendees, query, contactPicker.results])

  return {
    results,
    searching: contactPicker.searching,
    search,
  }
}

// Pure dispatch for SpeakerCandidate → action. Factored out of MeetingDetail
// so it can be unit-tested without rendering the full meeting page. Keeps
// the branching explicit: `contact` candidates link via TAG_SPEAKER_CONTACT;
// everything else (attendee picks, free-text Enter) flows through plain
// rename via RENAME_SPEAKERS.
export interface SpeakerCandidateHandlers {
  rename: (speakerIdx: number, name: string) => Promise<void>
  link: (speakerIdx: number, contact: ContactSummary) => Promise<void>
}

export async function dispatchSpeakerCandidate(
  speakerIdx: number,
  candidate: SpeakerCandidate,
  handlers: SpeakerCandidateHandlers,
): Promise<void> {
  if (candidate.kind === 'contact') {
    await handlers.link(speakerIdx, candidate.contact)
  } else {
    await handlers.rename(speakerIdx, candidate.name)
  }
}
