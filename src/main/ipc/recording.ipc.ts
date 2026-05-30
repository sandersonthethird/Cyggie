// =============================================================================
// recording.ipc.ts — desktop IPC adapter around RecordingSession.
//
// The audio→transcript→finalize pipeline lives in
// @cyggie/services/recording/RecordingSession. This file handles the
// Electron-specific wiring: ipcMain registrations, BrowserWindow/webContents
// broadcasts, tray menu updates, shell.openExternal for meeting URLs, and
// the _finalizations pending-promise registry that lets a same-meeting
// RECORDING_START await a previous RECORDING_STOP's background work.
// =============================================================================

import { ipcMain, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import {
  RecordingSession,
  resolveRecordingCalendarEventId,
} from '@cyggie/services/recording/RecordingSession'
import * as meetingRepo from '@cyggie/db/sqlite/repositories'
import { getCurrentUserProfile } from '../security/current-user'
import { updateTrayMenu } from '../tray'
import { addPending, removePending, getPending } from './_finalizations'
import { broadcast } from './_broadcast'
import { getSetting } from '@cyggie/db/sqlite/repositories/settings.repo'
import { getRecordingsDir } from '../storage/paths'
import {
  startAacEncoder,
  appendAacChunk,
  stopAacEncoder,
} from '../transcription-eval/audio/aac-encoder'

/**
 * Single gate point for the parallel AAC encoder used by the offline eval
 * CLI. Centralizes all four wiring sites (audio-chunk tap, encoder start,
 * encoder stop, error logging) so the `saveAudioForEval` toggle can be
 * honored in one place — much harder to half-wire than scattering
 * conditionals at each site.
 *
 * When enabled=false, the returned object is a complete no-op: no audio
 * tap is registered, no ffmpeg process is spawned, stop is a no-op. The
 * recording flow is identical to today's behavior with the encoder
 * disabled — zero overhead, zero disk usage.
 */
interface AacWiring {
  /** Pass into RecordingSession callbacks; undefined when disabled. */
  onAudioChunk?: (chunk: Buffer) => void
  /** Call after RecordingSession.start() resolves with the meetingId. */
  start: (meetingId: string) => void
  /** Call from the RECORDING_STOP handler; idempotent + non-blocking. */
  stop: () => void
}

function wireAacEncoder(enabled: boolean): AacWiring {
  if (!enabled) {
    return { start: () => {}, stop: () => {} }
  }
  return {
    onAudioChunk: (chunk) => appendAacChunk(chunk),
    start: (meetingId) => {
      try {
        const audioPath = join(getRecordingsDir(), `${meetingId}.m4a`)
        startAacEncoder(audioPath)
      } catch (err) {
        console.warn('[Recording] AAC encoder failed to start:', err)
      }
    },
    stop: () => {
      void stopAacEncoder().catch((err) => {
        console.warn('[Recording] AAC encoder failed to close cleanly:', err)
      })
    },
  }
}

// Re-export so the existing src/tests/recording-start.test.ts (which
// imports from '../main/ipc/recording.ipc') keeps working without churn.
export { resolveRecordingCalendarEventId }

let activeSession: RecordingSession | null = null
/**
 * Holds the AAC encoder's stop function for the currently-active session
 * so the RECORDING_STOP handler can fire it without re-reading the
 * saveAudioForEval setting. Reset to null when the session ends.
 */
let activeAacStop: (() => void) | null = null

function getMainWindow(): BrowserWindow | null {
  const windows = BrowserWindow.getAllWindows()
  return windows.length > 0 ? windows[0] : null
}

function sendToRenderer(channel: string, data: unknown): void {
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, data)
  }
}

async function openMeetingUrlInBrowser(url: string): Promise<void> {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return
    if (parsed.hostname === 'meet.google.com') {
      try {
        const email = getCurrentUserProfile().email
        if (email) parsed.searchParams.set('authuser', email)
      } catch {
        // Non-fatal: open without authuser if profile unavailable.
      }
    }
    await shell.openExternal(parsed.toString())
  } catch (err) {
    console.warn('[Recording] Failed to open meeting URL:', err)
  }
}

export function registerRecordingHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.RECORDING_START,
    async (
      _event,
      title?: string,
      calEventId?: string,
      appendToMeetingId?: string,
    ) => {
      // Idempotent re-fire from the renderer: if we're already recording
      // *this exact* calendar event, return the existing session info
      // rather than throwing. Anything else with an active session is a
      // user error and throws.
      if (activeSession?.isActive) {
        if (calEventId && activeSession.meetingId) {
          const currentMeeting = meetingRepo.getMeeting(activeSession.meetingId)
          if (currentMeeting?.calendarEventId === calEventId) {
            console.log(
              '[Recording] Already recording this calendar event, returning existing:',
              activeSession.meetingId,
            )
            return {
              meetingId: activeSession.meetingId,
              meetingPlatform: currentMeeting.meetingPlatform,
              alreadyRecording: true,
            }
          }
        }
        throw new Error('Already recording')
      }

      // Same-meeting race: if a previous RECORDING_STOP is still
      // finalizing this meetingId, wait for it before starting. The
      // background's `updateMeeting({status:'transcribed', ...})` would
      // otherwise race with our about-to-be-created fresh segments.
      if (appendToMeetingId) {
        const pending = getPending('recording', appendToMeetingId)
        if (pending) {
          console.log(
            `[Recording] Awaiting previous finalize for ${appendToMeetingId} before continuing`,
          )
          await pending
        }
      }

      // Single-gate AAC wiring. When saveAudioForEval is false (default),
      // the returned wiring is a no-op everywhere — no callback registered,
      // no ffmpeg process, no stop work.
      const aac = wireAacEncoder(getSetting('saveAudioForEval') === 'true')

      const session = new RecordingSession({
        onTranscriptUpdate: (segment) =>
          sendToRenderer(IPC_CHANNELS.RECORDING_TRANSCRIPT_UPDATE, segment),
        onStatus: (payload) => sendToRenderer(IPC_CHANNELS.RECORDING_STATUS, payload),
        onError: (message) => sendToRenderer(IPC_CHANNELS.RECORDING_ERROR, message),
        onAutoStop: () => sendToRenderer(IPC_CHANNELS.RECORDING_AUTO_STOP, null),
        onFinalized: (payload) => broadcast(IPC_CHANNELS.RECORDING_FINALIZED, payload),
        onFinalizeError: (payload) => broadcast(IPC_CHANNELS.RECORDING_FINALIZE_ERROR, payload),
        onProviderFallback: (payload) =>
          sendToRenderer(IPC_CHANNELS.RECORDING_PROVIDER_FALLBACK, payload),
        onAudioChunk: aac.onAudioChunk,
      })
      activeSession = session
      // Stash the stop function on the session ref so the RECORDING_STOP
      // handler doesn't need to re-read the setting.
      activeAacStop = aac.stop

      try {
        const result = await session.start({ title, calEventId, appendToMeetingId })
        // The "already recording this calendar event" recovery path
        // returns alreadyRecording=true from inside start() without
        // actually wiring the streaming client; drop our session reference
        // so the next genuine start can proceed.
        if (result.alreadyRecording) {
          activeSession = null
          activeAacStop = null
          return {
            meetingId: result.meetingId,
            meetingPlatform: result.meetingPlatform,
            alreadyRecording: true,
          }
        }
        aac.start(result.meetingId)
        if (result.meetingUrl) {
          void openMeetingUrlInBrowser(result.meetingUrl)
        }
        const win = getMainWindow()
        if (win) updateTrayMenu(win, true)
        return { meetingId: result.meetingId, meetingPlatform: result.meetingPlatform }
      } catch (err) {
        activeSession = null
        throw err
      }
    },
  )

  ipcMain.on('recording:system-audio-status', (_event, hasSystemAudio: boolean) => {
    activeSession?.onSystemAudioStatus(hasSystemAudio)
  })

  ipcMain.on('recording:audio-data', (_event, data: ArrayBuffer) => {
    activeSession?.feedAudio(Buffer.from(data))
  })

  ipcMain.on(IPC_CHANNELS.RECORDING_AEC_DEGRADED, () => {
    activeSession?.onAecDegraded()
  })

  ipcMain.on(IPC_CHANNELS.RECORDING_LOUDNESS_SAMPLE, (_event, sample: unknown) => {
    if (!sample || typeof sample !== 'object') return
    const s = sample as { tStart?: number; tEnd?: number; micDb?: number; sysDb?: number }
    if (
      typeof s.tStart !== 'number' ||
      typeof s.tEnd !== 'number' ||
      typeof s.micDb !== 'number' ||
      typeof s.sysDb !== 'number'
    ) {
      return
    }
    activeSession?.onLoudnessSample({
      tStart: s.tStart,
      tEnd: s.tEnd,
      micDb: s.micDb,
      sysDb: s.sysDb,
    })
  })

  ipcMain.handle(IPC_CHANNELS.RECORDING_PAUSE, () => {
    activeSession?.pause()
  })

  ipcMain.handle(IPC_CHANNELS.RECORDING_RESUME, () => {
    activeSession?.resume()
  })

  ipcMain.handle(IPC_CHANNELS.RECORDING_STOP, async () => {
    if (!activeSession?.isActive) {
      throw new Error('Not recording')
    }
    const session = activeSession
    const aacStop = activeAacStop
    activeSession = null
    activeAacStop = null

    const { meetingId, durationSeconds, finalizePromise } = session.stop()

    // Fire-and-forget AAC encoder close (no-op when saveAudioForEval was
    // false at session start).
    aacStop?.()

    const win = getMainWindow()
    if (win) updateTrayMenu(win, false)

    // Register the promise so a same-meeting RECORDING_START can await it.
    // Remove after settlement regardless of outcome.
    const tracked = finalizePromise.finally(() => removePending('recording', meetingId))
    addPending('recording', meetingId, tracked)

    return { meetingId, duration: durationSeconds }
  })
}
