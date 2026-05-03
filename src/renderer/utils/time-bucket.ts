export type TimeBucket = 'today' | 'yesterday' | 'thisWeek' | 'lastWeek' | 'earlier'

export const TIME_BUCKET_ORDER: TimeBucket[] = [
  'today',
  'yesterday',
  'thisWeek',
  'lastWeek',
  'earlier',
]

export const TIME_BUCKET_LABEL: Record<TimeBucket, string> = {
  today: 'TODAY',
  yesterday: 'YESTERDAY',
  thisWeek: 'THIS WEEK',
  lastWeek: 'LAST WEEK',
  earlier: 'EARLIER',
}

function startOfDay(d: Date): Date {
  const out = new Date(d)
  out.setHours(0, 0, 0, 0)
  return out
}

const DAY_MS = 86_400_000

/**
 * Bucket an ISO timestamp into Today / Yesterday / This week / Last week / Earlier
 * relative to `now`. Weeks start Monday.
 *
 * Invalid ISO strings (NaN getTime) bucket to 'earlier' rather than throwing —
 * the row still appears in the UI, just at the bottom.
 */
export function bucketFor(iso: string, now: Date = new Date()): TimeBucket {
  const date = new Date(iso)
  if (isNaN(date.getTime())) return 'earlier'

  const today = startOfDay(now)
  const target = startOfDay(date)

  if (target.getTime() === today.getTime()) return 'today'
  if (target.getTime() === today.getTime() - DAY_MS) return 'yesterday'

  // Monday-anchored week boundaries (ISO weeks).
  const dayOfWeek = (today.getDay() + 6) % 7 // Mon=0 .. Sun=6
  const startOfThisWeek = new Date(today.getTime() - dayOfWeek * DAY_MS)
  const startOfLastWeek = new Date(startOfThisWeek.getTime() - 7 * DAY_MS)

  if (target.getTime() >= startOfThisWeek.getTime()) return 'thisWeek'
  if (target.getTime() >= startOfLastWeek.getTime()) return 'lastWeek'
  return 'earlier'
}

/**
 * Build the right-aligned date label shown next to each bucket header.
 * Examples: "Sat, May 2 · 3" (single day), "Apr 28 – Apr 30" (range).
 * The count suffix is appended by the caller; this function only returns the
 * date portion. Returns '' when the range would be empty.
 */
export function bucketHeaderRange(
  bucket: TimeBucket,
  now: Date = new Date()
): string {
  const today = startOfDay(now)

  if (bucket === 'today') {
    return today.toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    })
  }
  if (bucket === 'yesterday') {
    const y = new Date(today.getTime() - DAY_MS)
    return y.toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    })
  }

  const dayOfWeek = (today.getDay() + 6) % 7
  const startOfThisWeek = new Date(today.getTime() - dayOfWeek * DAY_MS)
  const startOfLastWeek = new Date(startOfThisWeek.getTime() - 7 * DAY_MS)

  if (bucket === 'thisWeek') {
    const start = startOfThisWeek
    const end = new Date(today.getTime() - 2 * DAY_MS)
    if (end.getTime() < start.getTime()) return ''
    return `${start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
  }
  if (bucket === 'lastWeek') {
    const end = new Date(startOfThisWeek.getTime() - DAY_MS)
    return `${startOfLastWeek.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
  }
  return ''
}
