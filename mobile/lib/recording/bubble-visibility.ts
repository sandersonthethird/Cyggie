// Pure visibility decision for the floating RecordingBubble, extracted so it
// can be unit-tested without a React-Native renderer.
//
// Show the bubble only while ACTIVELY recording, with a known meeting, and only
// when the user is somewhere OTHER than that meeting's own view (the in-view
// RecordingBanner covers that case).
export function shouldShowRecordingBubble(input: {
  status: string
  activeMeetingId: string | null
  pathname: string
}): boolean {
  const { status, activeMeetingId, pathname } = input
  if (status !== 'recording') return false
  if (!activeMeetingId) return false
  if (pathname === `/meetings/${activeMeetingId}`) return false
  return true
}
