import { desktopCapturer } from 'electron'
import {
  MEETING_APPS,
  type MeetingPlatform,
  type DetectablePlatform
} from '../../shared/constants/meeting-apps'

/**
 * Window-based meeting detection.
 *
 * The meeting "window" is the real end-of-meeting signal: closing a Zoom
 * meeting window / leaving a Meet tab removes the window even though the app
 * (Zoom.us, Chrome) keeps running, so process-liveness can't see it. Reading
 * window titles via desktopCapturer needs only the Screen Recording permission
 * the app already holds for system-audio capture — no extra permission.
 *
 * Title matching lives in MEETING_APPS.titlePatterns (single source of truth);
 * this module never hardcodes title strings.
 */

// We only read id + name off a source, so accept the minimal shape. This lets
// callers (and tests) pass plain objects without the full Electron type.
export type WindowSource = Pick<Electron.DesktopCapturerSource, 'id' | 'name'>

/** Enumerate open windows. thumbnailSize 0 skips the expensive thumbnail capture. */
export async function getWindowSources(): Promise<WindowSource[]> {
  return desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 0, height: 0 }
  })
}

function titleMatches(name: string, platform: DetectablePlatform): boolean {
  const lower = name.toLowerCase()
  return MEETING_APPS[platform].titlePatterns.some((p) => lower.includes(p))
}

/**
 * Pick the best window for a platform — the *active meeting* window over
 * ancillary ones. Used by video capture to target the right window.
 * Returns null for 'other' or when nothing matches.
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

/** Which detectable platforms currently have at least one meeting window open. */
export function detectMeetingWindowPlatforms(
  sources: WindowSource[]
): Set<DetectablePlatform> {
  const present = new Set<DetectablePlatform>()
  for (const platform of Object.keys(MEETING_APPS) as DetectablePlatform[]) {
    if (sources.some((s) => titleMatches(s.name, platform))) {
      present.add(platform)
    }
  }
  return present
}
