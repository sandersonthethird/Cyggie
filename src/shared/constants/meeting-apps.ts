export const MEETING_APPS = {
  zoom: {
    name: 'Zoom',
    macBundleId: 'us.zoom.xos',
    processName: 'zoom.us',
    urlPatterns: [/zoom\.us\/j\//, /zoom\.us\/my\//]
  },
  google_meet: {
    name: 'Google Meet',
    macBundleId: null,
    processName: null,
    urlPatterns: [/meet\.google\.com\//]
  },
  teams: {
    name: 'Microsoft Teams',
    macBundleId: 'com.microsoft.teams2',
    processName: 'Microsoft Teams',
    urlPatterns: [/teams\.microsoft\.com\//, /teams\.live\.com\//]
  }
} as const

export type MeetingPlatform = keyof typeof MEETING_APPS | 'other'
