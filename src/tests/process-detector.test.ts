import { describe, it, expect, vi, beforeEach } from 'vitest'

const execSyncMock = vi.fn()
vi.mock('child_process', () => ({ execSync: (...args: unknown[]) => execSyncMock(...args) }))

import { detectRunningMeetingApps, isMeetingAppRunning } from '../main/audio/process-detector'

const originalPlatform = process.platform

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

describe('detectRunningMeetingApps', () => {
  beforeEach(() => {
    execSyncMock.mockReset()
    setPlatform('darwin')
  })

  it('returns empty + ok on non-darwin platforms', () => {
    setPlatform('linux')
    expect(detectRunningMeetingApps()).toEqual({ apps: [], status: 'ok' })
    expect(execSyncMock).not.toHaveBeenCalled()
    setPlatform(originalPlatform)
  })

  it('parses Zoom and Teams processes from ps output', () => {
    execSyncMock.mockReturnValueOnce(
      [
        'sandy   1234   0.0 0.5 12345 6789 ?? Ss 9:00AM 0:01.23 /Applications/zoom.us.app/Contents/MacOS/zoom.us',
        'sandy   5678   0.0 0.5 12345 6789 ?? Ss 9:00AM 0:01.23 /Applications/Microsoft Teams.app/Contents/MacOS/MSTeams'
      ].join('\n')
    )
    const result = detectRunningMeetingApps()
    expect(result.status).toBe('ok')
    expect(result.apps).toHaveLength(2)
    expect(result.apps.map((a) => a.platform).sort()).toEqual(['teams', 'zoom'])
    expect(result.apps.find((a) => a.platform === 'zoom')?.pid).toBe(1234)
    expect(result.apps.find((a) => a.platform === 'teams')?.pid).toBe(5678)
  })

  it("treats grep's 'no matches' exit code 1 as ok with no apps", () => {
    const err = Object.assign(new Error('command failed'), { status: 1 })
    execSyncMock.mockImplementationOnce(() => {
      throw err
    })
    expect(detectRunningMeetingApps()).toEqual({ apps: [], status: 'ok' })
  })

  it('returns status=error when ps fails with non-1 exit (timeout, signal, ENOENT)', () => {
    const err = Object.assign(new Error('timeout'), { status: 124 })
    execSyncMock.mockImplementationOnce(() => {
      throw err
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(detectRunningMeetingApps()).toEqual({ apps: [], status: 'error' })
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('recognizes the New Teams (MSTeams.app / com.microsoft.teams2) binary path', () => {
    execSyncMock.mockReturnValueOnce(
      'sandy   4242   0.0 0.5 12345 6789 ?? Ss 9:00AM 0:01.23 /Applications/MSTeams.app/Contents/MacOS/MSTeams --foo=bar'
    )
    const result = detectRunningMeetingApps()
    expect(result.status).toBe('ok')
    expect(result.apps).toHaveLength(1)
    expect(result.apps[0]).toMatchObject({ platform: 'teams', pid: 4242 })
  })

  it('recognizes com.microsoft.teams2 bundle id in cmdline', () => {
    execSyncMock.mockReturnValueOnce(
      'sandy   9999   0.0 0.5 12345 6789 ?? Ss 9:00AM 0:01.23 /private/var/folders/.../com.microsoft.teams2/helper'
    )
    const result = detectRunningMeetingApps()
    expect(result.apps).toHaveLength(1)
    expect(result.apps[0].platform).toBe('teams')
  })

  it('recognizes Teams Helper processes via case-insensitive Microsoft Teams match', () => {
    execSyncMock.mockReturnValueOnce(
      'sandy   1111   0.0 0.5 12345 6789 ?? Ss 9:00AM 0:01.23 /Applications/Microsoft Teams.app/Contents/Frameworks/Microsoft Teams Helper (Renderer).app/Contents/MacOS/Microsoft Teams Helper (Renderer)'
    )
    const result = detectRunningMeetingApps()
    expect(result.apps).toHaveLength(1)
    expect(result.apps[0].platform).toBe('teams')
  })

  it('ignores Chrome processes even though grep matches them', () => {
    execSyncMock.mockReturnValueOnce(
      'sandy   2222   0.0 0.5 12345 6789 ?? Ss 9:00AM 0:01.23 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    )
    const result = detectRunningMeetingApps()
    expect(result.apps).toHaveLength(0)
    expect(result.status).toBe('ok')
  })
})

describe('isMeetingAppRunning', () => {
  beforeEach(() => {
    execSyncMock.mockReset()
    setPlatform('darwin')
  })

  it('returns true when ps reports a meeting app', () => {
    execSyncMock.mockReturnValueOnce(
      'sandy   1234   0.0 0.5 12345 6789 ?? Ss 9:00AM 0:01.23 /Applications/zoom.us.app/Contents/MacOS/zoom.us'
    )
    expect(isMeetingAppRunning()).toBe(true)
  })

  it('returns false when ps reports no matches', () => {
    const err = Object.assign(new Error('no matches'), { status: 1 })
    execSyncMock.mockImplementationOnce(() => {
      throw err
    })
    expect(isMeetingAppRunning()).toBe(false)
  })

  it('returns false (conservative) when ps errors out', () => {
    const err = Object.assign(new Error('boom'), { status: 137 })
    execSyncMock.mockImplementationOnce(() => {
      throw err
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(isMeetingAppRunning()).toBe(false)
    warnSpy.mockRestore()
  })
})
