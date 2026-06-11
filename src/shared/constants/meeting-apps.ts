// `titlePatterns` are lowercased substrings matched against OS window titles
// to decide "is a live meeting window of this platform open?". They are the
// SINGLE source of truth for both window-presence detection (auto-stop) and
// capture-window targeting (video.ipc) — keep title matching here, not
// duplicated across call sites (Zoom's rename 'Zoom Meeting' → 'Zoom Workplace'
// is exactly the drift this prevents).
//
// `preferredTitles` mark the *active meeting* window, chosen over ancillary
// windows of the same app when picking ONE window to capture.
export const MEETING_APPS = {
  zoom: {
    name: 'Zoom',
    macBundleId: 'us.zoom.xos',
    processName: 'zoom.us',
    urlPatterns: [/zoom\.us\/j\//, /zoom\.us\/my\//],
    titlePatterns: ['zoom'],
    preferredTitles: ['Zoom Meeting', 'Zoom Workplace']
  },
  google_meet: {
    name: 'Google Meet',
    macBundleId: null,
    processName: null,
    urlPatterns: [/meet\.google\.com\//],
    titlePatterns: ['google meet', 'meet.google.com'],
    preferredTitles: ['Google Meet']
  },
  teams: {
    name: 'Microsoft Teams',
    macBundleId: 'com.microsoft.teams2',
    processName: 'Microsoft Teams',
    urlPatterns: [/teams\.microsoft\.com\//, /teams\.live\.com\//],
    titlePatterns: ['teams'],
    // Teams prefers a call/meeting window over the main hub via an exclusion
    // heuristic in findMeetingWindow rather than a positive title match.
    preferredTitles: []
  }
} as const

export type MeetingPlatform = keyof typeof MEETING_APPS | 'other'

// Platforms with a window-title signature (everything except 'other').
export type DetectablePlatform = keyof typeof MEETING_APPS
