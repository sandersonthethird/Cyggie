export interface ResolvedAttendee {
  index: number
  name: string
  email: string
  contactId: string | null
  fullName: string | null
}

export type AttendeeContactMap = Record<string, { id: string; fullName: string } | undefined>

// meeting.attendees      [Alice, Alice, Bob]
// meeting.attendeeEmails [a@,    b@,    bob@]
// attendeeContactMap     {a@ → {id:1}, b@ → {id:1}, bob@ → {id:2}}
//                                ▲          ▲
//                          both resolve to contact 1
// result → [{index:0, contactId:1, ...}, {index:2, contactId:2, ...}]
//
// Unresolved emails (contactId null) always pass through. First occurrence
// of each contactId wins; original render order preserved.
export function dedupResolvedAttendees(
  attendees: string[],
  attendeeEmails: string[] | undefined,
  attendeeContactMap: AttendeeContactMap,
): ResolvedAttendee[] {
  const seenContactIds = new Set<string>()
  const out: ResolvedAttendee[] = []
  for (let i = 0; i < attendees.length; i++) {
    const name = attendees[i] ?? ''
    const email = (attendeeEmails?.[i] ?? '').trim().toLowerCase()
    const resolved = attendeeContactMap[email] ?? attendeeContactMap[name.trim().toLowerCase()]
    const contactId = resolved?.id ?? null
    if (contactId) {
      if (seenContactIds.has(contactId)) continue
      seenContactIds.add(contactId)
    }
    out.push({ index: i, name, email, contactId, fullName: resolved?.fullName ?? null })
  }
  return out
}

// Cheaper fallback for list/feed views (MeetingRow, MeetingCard, CalendarBadge)
// that don't resolve attendees to contacts. Collapses entries by lowercased
// display name. Catches the common case where Alice is invited with two of her
// email addresses (calendar lists her name twice); accepted false-positive: two
// distinct namesakes at the same meeting collapse to one row.
export function dedupAttendeesByName(
  attendees: string[],
  attendeeEmails?: string[],
): ResolvedAttendee[] {
  const seen = new Set<string>()
  const out: ResolvedAttendee[] = []
  for (let i = 0; i < attendees.length; i++) {
    const name = attendees[i] ?? ''
    const email = (attendeeEmails?.[i] ?? '').trim().toLowerCase()
    const key = name.trim().toLowerCase()
    if (key) {
      if (seen.has(key)) continue
      seen.add(key)
    }
    out.push({ index: i, name, email, contactId: null, fullName: null })
  }
  return out
}
