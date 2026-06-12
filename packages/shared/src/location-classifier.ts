// location-classifier.ts — shared by desktop (renderer + main), gateway, and
// mobile to decide what a Google Calendar event's `location` field actually
// means. The field is overloaded: Google auto-attaches a Meet link to most
// events (so a `meetingUrl` alone can't tell in-person from video), and users
// type all sorts of things into `location`:
//
//   ┌─────────────────────────────┬──────────────┐
//   │ location text               │ classifyLocation
//   ├─────────────────────────────┼──────────────┤
//   │ "124 Main St, SF"           │ 'in_person'  │  → Maps chip
//   │ "Conference Room B"         │ 'in_person'  │  → Maps chip (search is weak but harmless)
//   │ "Sandy to call James 555-…" │ 'phone'      │  → Call chip (never "In person")
//   │ "https://zoom.us/j/123"     │ 'video'      │  → video chip
//   │ ""  /  null                 │ 'none'       │  → fall back to meetingUrl/platform
//   └─────────────────────────────┴──────────────┘
//
// This is a heuristic — it will misjudge the long tail (an address that
// happens to contain a phone number, a room named "Phone Booth", etc.). That
// is acceptable: the cost of a wrong chip is low, and the common cases
// (real address, "call X at <number>", a pasted conference URL) are clear.
//
// Keep this pure and dependency-free so all three runtimes can import it.

export type LocationKind = 'in_person' | 'phone' | 'video' | 'none'

// A URL anywhere in the string → treat as a video/conference link. Covers
// bare "zoom.us"/"meet.google.com" mentions as well as full http(s) URLs.
const URL_RE = /(https?:\/\/|\b(?:meet\.google\.com|zoom\.us|teams\.microsoft\.com|webex\.com)\b)/i

// A phone number: 7+ digits with common separators, or an international
// +<digits> form. Deliberately loose — we only need to recognise that a
// number is present, not validate it.
const PHONE_RE = /(\+\d[\d\s().-]{6,}\d)|(\b\d{3}[\s.-]\d{3}[\s.-]\d{4}\b)|(\b\d{3}[\s.-]\d{4}\b)/

// Call-intent keywords. Matched as whole words so "callout" / "recall" don't
// trip it. Paired with the phone check via OR: either signal marks a phone
// meeting.
const CALL_WORD_RE = /\b(call|dial|phone|tel|telephone)\b/i

/**
 * Classify a calendar event's free-text `location` into a display intent.
 * Order matters: a pasted conference URL wins over a phone number (some
 * dial-in blocks include both a URL and a number), and any non-empty string
 * that isn't a URL or phone is assumed to be a physical place.
 */
export function classifyLocation(location: string | null | undefined): LocationKind {
  const text = (location ?? '').trim()
  if (text.length === 0) return 'none'
  if (URL_RE.test(text)) return 'video'
  if (PHONE_RE.test(text) || CALL_WORD_RE.test(text)) return 'phone'
  return 'in_person'
}

/**
 * Extract the first phone number from a `phone`-classified location so the UI
 * can build a `tel:` link. Returns the digits (with a leading + preserved for
 * international numbers) or null when nothing parseable is present, in which
 * case the caller should fall back to plain text.
 */
export function extractPhoneNumber(location: string | null | undefined): string | null {
  const m = (location ?? '').match(PHONE_RE)
  if (!m) return null
  const raw = m[0]
  const hasPlus = raw.trimStart().startsWith('+')
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 0) return null
  return hasPlus ? `+${digits}` : digits
}

/**
 * Extract the first URL from a `video`-classified location so the UI can open
 * it. Bare-domain mentions (no scheme) get an https:// prefix.
 */
export function extractLocationUrl(location: string | null | undefined): string | null {
  const text = location ?? ''
  const full = text.match(/https?:\/\/\S+/i)
  if (full) return full[0]
  const bare = text.match(/\b(?:meet\.google\.com|zoom\.us|teams\.microsoft\.com|webex\.com)\S*/i)
  if (bare) return `https://${bare[0]}`
  return null
}
