import { execSync } from 'child_process'
import type { MeetingPlatform } from '../../shared/constants/meeting-apps'

export interface RunningMeetingApp {
  platform: MeetingPlatform
  name: string
  pid: number
}

export interface DetectionResult {
  apps: RunningMeetingApp[]
  status: 'ok' | 'error'
}

export function detectRunningMeetingApps(): DetectionResult {
  if (process.platform !== 'darwin') return { apps: [], status: 'ok' }

  try {
    const output = execSync(
      'ps aux | grep -i "zoom\\|teams\\|google chrome" | grep -v grep',
      { encoding: 'utf-8', timeout: 5000 }
    )

    const apps: RunningMeetingApp[] = []
    for (const line of output.split('\n').filter(Boolean)) {
      const parts = line.split(/\s+/)
      const pid = parseInt(parts[1], 10)
      const cmd = parts.slice(10).join(' ').toLowerCase()

      if (cmd.includes('zoom.us') || cmd.includes('us.zoom.xos')) {
        apps.push({ platform: 'zoom', name: 'Zoom', pid })
      } else if (
        cmd.includes('microsoft teams') ||
        cmd.includes('com.microsoft.teams') ||
        cmd.includes('msteams')
      ) {
        apps.push({ platform: 'teams', name: 'Microsoft Teams', pid })
      }
    }
    return { apps, status: 'ok' }
  } catch (err) {
    // grep exits 1 when no lines match — that's success, not an error
    if ((err as { status?: number })?.status === 1) {
      return { apps: [], status: 'ok' }
    }
    console.warn('[ProcessDetector] ps failed:', err)
    return { apps: [], status: 'error' }
  }
}

export function isMeetingAppRunning(): boolean {
  const result = detectRunningMeetingApps()
  return result.status === 'ok' && result.apps.length > 0
}
