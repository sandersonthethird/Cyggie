import { spawn, type ChildProcess } from 'child_process'
import { createInterface } from 'readline'
import { join } from 'path'
import { app } from 'electron'
import {
  MEETING_APP_BUNDLE_IDS,
  BROWSER_BUNDLE_IDS,
  type MeetingPlatform,
  type DetectablePlatform
} from '../../shared/constants/meeting-apps'

/**
 * Stops a recording the instant the meeting app releases the microphone — i.e.
 * the call ended — which is how Granola actually detects meeting end (audio
 * activity), not window-close. This catches Google Meet's red-button "leave"
 * (which never closes the browser window), Zoom, and Teams uniformly, with NO
 * new permission (Cyggie already has audio access).
 *
 * A bundled Swift helper (native/meeting-audio-watch) streams the set of host
 * bundle ids currently capturing mic input, one JSON line per change:
 *   {"bundles":["com.google.Chrome","us.zoom.xos"]}
 * All meeting-vs-not logic lives here in TS (unit-testable); the helper is dumb.
 *
 *   spawn helper ──▶ onLine(JSON) ──▶ handleBundles(bundles)
 *                                         │
 *        isMeetingActive(bundles)? ◀──────┤
 *          true  → seenActive=true, cancel any pending end
 *          false → (only if seenActive) start endDebounce timer
 *                                         │
 *                     debounce elapses ───▶ onMeetingEnded()  (→ auto-stop)
 *
 * `seenActive` gates everything: we only stop AFTER the meeting app was on the
 * mic and then let go. That also protects the "record, wait for a late
 * participant" flow — you've joined, so the app holds the mic the whole time;
 * the stop only fires when it's actually released.
 */

const DEFAULT_END_DEBOUNCE_MS = 1500 // mic must stay released this long → ended

interface MeetingAudioWatcherOptions {
  /** Known platform → watch just that app; null/'other' → any known meeting app/browser. */
  meetingPlatform?: MeetingPlatform | null
  onMeetingEnded: () => void
  /** Path to the compiled Swift helper; defaults to the bundled location. */
  helperPath?: string
  endDebounceMs?: number
}

function defaultHelperPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'meeting-audio-watch')
    : join(app.getAppPath(), 'native', 'meeting-audio-watch', 'meeting-audio-watch')
}

export class MeetingAudioWatcher {
  private readonly meetingPlatform: MeetingPlatform | null
  private readonly onEnded: () => void
  private readonly helperPath: string
  private readonly endDebounceMs: number

  private proc: ChildProcess | null = null
  private endTimer: NodeJS.Timeout | null = null
  private seenActive = false
  private stopped = false

  constructor(options: MeetingAudioWatcherOptions) {
    this.meetingPlatform = options.meetingPlatform ?? null
    this.onEnded = options.onMeetingEnded
    this.helperPath = options.helperPath ?? defaultHelperPath()
    this.endDebounceMs = options.endDebounceMs ?? DEFAULT_END_DEBOUNCE_MS
  }

  start(): void {
    if (process.platform !== 'darwin') return // helper is macOS-only
    try {
      this.proc = spawn(this.helperPath, [], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      console.warn('[AudioWatcher] failed to spawn helper; inert:', err)
      return
    }
    this.proc.on('error', (err) =>
      console.warn('[AudioWatcher] helper process error (inert):', err)
    )
    this.proc.stderr?.on('data', (d) => console.warn('[AudioWatcher] helper stderr:', String(d).trim()))
    this.proc.on('exit', (code) => {
      if (!this.stopped) console.warn(`[AudioWatcher] helper exited unexpectedly (code ${code})`)
    })
    if (this.proc.stdout) {
      createInterface({ input: this.proc.stdout }).on('line', (line) => this.onLine(line))
    }
    console.log(
      `[AudioWatcher] started; watching ${this.meetingPlatform ?? 'any meeting app'} via ${this.helperPath}`
    )
  }

  private onLine(line: string): void {
    let bundles: unknown
    try {
      bundles = (JSON.parse(line) as { bundles?: unknown }).bundles
    } catch {
      return
    }
    if (Array.isArray(bundles)) this.handleBundles(bundles as string[])
  }

  /** Pure-ish state machine over the current mic-input host bundle ids. Unit-tested. */
  handleBundles(bundles: string[]): void {
    if (this.stopped) return
    if (this.isMeetingActive(bundles)) {
      this.seenActive = true
      if (this.endTimer) {
        clearTimeout(this.endTimer)
        this.endTimer = null
      }
      return
    }
    // Meeting app not on the mic. Only meaningful once it HAS been active.
    if (this.seenActive && !this.endTimer) {
      this.endTimer = setTimeout(() => {
        this.endTimer = null
        console.log('[AudioWatcher] meeting app released the mic — meeting ended')
        this.onEnded()
      }, this.endDebounceMs)
    }
  }

  /** Whether the recording's meeting app is currently capturing mic input. */
  isMeetingActive(bundles: string[]): boolean {
    const set = new Set(bundles)
    const matches = (p: DetectablePlatform): boolean =>
      p === 'google_meet'
        ? BROWSER_BUNDLE_IDS.some((b) => set.has(b))
        : MEETING_APP_BUNDLE_IDS[p].some((b) => set.has(b))

    if (this.meetingPlatform && this.meetingPlatform !== 'other') {
      return matches(this.meetingPlatform as DetectablePlatform)
    }
    // Unknown platform: any known meeting app OR a browser holding the mic.
    return matches('zoom') || matches('teams') || matches('google_meet')
  }

  stop(): void {
    this.stopped = true
    if (this.endTimer) {
      clearTimeout(this.endTimer)
      this.endTimer = null
    }
    if (this.proc) {
      this.proc.kill()
      this.proc = null
    }
  }
}
