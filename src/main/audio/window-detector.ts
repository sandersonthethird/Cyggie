import {
  MEETING_APPS,
  type MeetingPlatform,
  type DetectablePlatform
} from '../../shared/constants/meeting-apps'

/**
 * Find the active meeting window for a platform among desktopCapturer sources,
 * for targeting screen capture (video.ipc). Title patterns live in
 * MEETING_APPS.titlePatterns (single source of truth).
 */

// We only read id + name off a source, so accept the minimal shape. This lets
// callers (and tests) pass plain objects without the full Electron type.
export type WindowSource = Pick<Electron.DesktopCapturerSource, 'id' | 'name'>

function titleMatches(name: string, platform: DetectablePlatform): boolean {
  const lower = name.toLowerCase()
  return MEETING_APPS[platform].titlePatterns.some((p) => lower.includes(p))
}

/**
 * Pick the best window for a platform — the *active meeting* window over
 * ancillary ones. Returns null for 'other' or when nothing matches.
 */
export function findMeetingWindow(
  sources: WindowSource[],
  platform: MeetingPlatform
): WindowSource | null {
  if (platform === 'other' || !(platform in MEETING_APPS)) return null
  const detectable = platform as DetectablePlatform

  const matches = sources.filter((s) => titleMatches(s.name, detectable))
  if (matches.length === 0) return null

  const preferred = MEETING_APPS[detectable].preferredTitles
  if (preferred.length > 0) {
    const hit = matches.find((s) => preferred.some((t) => s.name.includes(t)))
    if (hit) return hit
  }

  // Teams: prefer a call/meeting window over the main hub (titled exactly
  // "Microsoft Teams…"). Falls through to first match if only the hub exists.
  if (detectable === 'teams') {
    return (
      matches.find((s) => !s.name.startsWith('Microsoft Teams') || matches.length === 1) ||
      matches[0]
    )
  }

  return matches[0]
}
