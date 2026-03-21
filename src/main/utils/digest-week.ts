/**
 * Returns the ISO date string for the current or next Tuesday.
 *
 * Day calculation:
 *   Sun(0) → +2   Mon(1) → +1   Tue(2) → +0
 *   Wed(3) → +6   Thu(4) → +5   Fri(5) → +4   Sat(6) → +3
 *
 * Formula: (2 - day + 7) % 7  gives days until next Tuesday (0 if today is Tuesday)
 */
export function currentDigestTuesday(now: Date = new Date()): string {
  const day = now.getDay()
  const daysUntilTuesday = (2 - day + 7) % 7
  const tuesday = new Date(now)
  tuesday.setDate(now.getDate() + daysUntilTuesday)
  return tuesday.toISOString().split('T')[0]
}

/**
 * Returns the ISO date string for the Tuesday of the NEXT week after the given date.
 * Used when creating the next digest after concluding the current one.
 */
export function nextDigestTuesday(afterDate: Date = new Date()): string {
  const day = afterDate.getDay()
  // Days until next Tuesday (always at least 1 day ahead)
  const daysUntilNext = day === 2
    ? 7   // today is Tuesday → next Tuesday is 7 days away
    : (2 - day + 7) % 7
  const tuesday = new Date(afterDate)
  tuesday.setDate(afterDate.getDate() + daysUntilNext)
  return tuesday.toISOString().split('T')[0]
}

/**
 * Returns the ISO date string for the Tuesday one week before the given date.
 * Used to determine the activity window for the suggestions query.
 */
export function previousTuesday(from: Date = new Date()): string {
  const current = currentDigestTuesday(from)
  const d = new Date(current)
  d.setDate(d.getDate() - 7)
  return d.toISOString().split('T')[0]
}
