import { MEETING_APPS, type MeetingPlatform } from '../../shared/constants/meeting-apps'

interface DetectedMeeting {
  url: string
  platform: MeetingPlatform
}

/**
 * Extract video conferencing links from calendar event data.
 * Checks conferenceData (structured) and falls back to scanning
 * the description and location for known URL patterns.
 */
export function detectMeetingLink(event: {
  conferenceData?: {
    entryPoints?: Array<{ entryPointType?: string; uri?: string }>
  } | null
  description?: string | null
  location?: string | null
  hangoutLink?: string | null
}): DetectedMeeting | null {
  // Check Google Meet hangout link
  if (event.hangoutLink) {
    return { url: event.hangoutLink, platform: 'google_meet' }
  }

  // Check structured conferenceData
  if (event.conferenceData?.entryPoints) {
    for (const ep of event.conferenceData.entryPoints) {
      if (ep.entryPointType === 'video' && ep.uri) {
        const platform = matchUrlToPlatform(ep.uri)
        if (platform) return { url: ep.uri, platform }
      }
    }
  }

  // Scan description and location for meeting URLs
  const textToScan = [event.description || '', event.location || ''].join(' ')
  return extractMeetingUrlFromText(textToScan)
}

function matchUrlToPlatform(url: string): MeetingPlatform | null {
  for (const [key, app] of Object.entries(MEETING_APPS)) {
    for (const pattern of app.urlPatterns) {
      if (pattern.test(url)) {
        return key as MeetingPlatform
      }
    }
  }
  return null
}

function extractMeetingUrlFromText(text: string): DetectedMeeting | null {
  // Extract URLs from text
  const urlRegex = /https?:\/\/[^\s<>"']+/gi
  const urls = text.match(urlRegex)
  if (!urls) return null

  for (const url of urls) {
    const platform = matchUrlToPlatform(url)
    if (platform) {
      return { url, platform }
    }
  }

  return null
}
