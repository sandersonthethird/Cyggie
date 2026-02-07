import { execSync } from 'child_process'
import { MEETING_APPS, type MeetingPlatform } from '../../shared/constants/meeting-apps'

export interface RunningMeetingApp {
  platform: MeetingPlatform
  name: string
  pid: number
}

export function detectRunningMeetingApps(): RunningMeetingApp[] {
  if (process.platform !== 'darwin') return []

  const apps: RunningMeetingApp[] = []

  try {
    const output = execSync(
      'ps aux | grep -i "zoom\\|teams\\|google chrome" | grep -v grep',
      { encoding: 'utf-8', timeout: 5000 }
    )

    const lines = output.split('\n').filter(Boolean)

    for (const line of lines) {
      const parts = line.split(/\s+/)
      const pid = parseInt(parts[1], 10)
      const command = parts.slice(10).join(' ')

      if (command.includes('zoom.us') || command.includes('us.zoom.xos')) {
        apps.push({ platform: 'zoom', name: 'Zoom', pid })
      } else if (command.includes('Microsoft Teams') || command.includes('com.microsoft.teams')) {
        apps.push({ platform: 'teams', name: 'Microsoft Teams', pid })
      }
    }
  } catch {
    // ps command failed or no matching processes
  }

  return apps
}

export function isMeetingAppRunning(): boolean {
  return detectRunningMeetingApps().length > 0
}
