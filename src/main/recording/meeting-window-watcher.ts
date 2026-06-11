import type { MeetingPlatform, DetectablePlatform } from '../../shared/constants/meeting-apps'
import {
  detectMeetingWindowPlatforms,
  getWindowSources as defaultGetWindowSources,
  type WindowSource
} from '../audio/window-detector'

/**
 * Watches whether the meeting window the recording is attached to is still
 * open, and fires `onGone()` the moment it closes — the fast, intentional
 * end-of-meeting signal (Granola-style).
 *
 * Two signals, one `onGone`:
 *   A. window-presence poll (primary, all platforms, uses the already-granted
 *      Screen Recording permission)
 *   B. notifyTrackEnded() — the captured window's video track 'ended' event
 *      forwarded from the renderer (bonus, video sessions only; best-effort
 *      since Chromium fires 'ended' unreliably).
 *
 * The 45s floor + idempotent stop live in RecordingAutoStop.onWindowGone (the
 * single decision point) — this class only decides "the window is gone". It is
 * deliberately NON-latching: it reports `onGone()` on every poll where the
 * window is absent past the debounce, because the consumer may reject an early
 * report under the floor and we must keep reporting until it accepts (then it
 * calls stop()). The consumer dedupes via its own `triggered` guard.
 *
 *   ┌──────┐ start(): a meeting window present?
 *   │ IDLE │──── no ───▶ INERT (no poll; calendar/silence remain the fallback)
 *   └──┬───┘
 *      │ yes — arm watchedPlatforms
 *      ▼
 *   ┌────────┐ poll every pollIntervalMs
 *   │ ARMED  │── watched window present ──▶ absenceCount = 0  (tab switch / glitch)
 *   │        │── all watched absent ─────▶ absenceCount++
 *   └──┬─────┘                              │
 *      │ absenceCount ≥ absenceDebounce  ◀──┘   (or notifyTrackEnded())
 *      ▼
 *    onGone()  ── reported each qualifying tick until consumer calls stop()
 */

const DEFAULT_POLL_INTERVAL_MS = 750
const DEFAULT_ABSENCE_DEBOUNCE = 2 // consecutive absent polls ≈ 1.5s before firing

interface WatcherOptions {
  /** The recording's known platform; null/'other' → watch whatever is present at start. */
  meetingPlatform?: MeetingPlatform | null
  /** Called once when the watched meeting window is judged gone. */
  onGone: () => void
  /** Injected for tests; defaults to the real desktopCapturer enumeration. */
  getWindowSources?: () => Promise<WindowSource[]>
  pollIntervalMs?: number
  absenceDebounce?: number
}

export class MeetingWindowWatcher {
  private readonly onGone: () => void
  private readonly meetingPlatform: MeetingPlatform | null
  private readonly getWindowSources: () => Promise<WindowSource[]>
  private readonly pollIntervalMs: number
  private readonly absenceDebounce: number

  private poller: NodeJS.Timeout | null = null
  private watchedPlatforms = new Set<DetectablePlatform>()
  private absenceCount = 0
  private inFlight = false
  private stopped = false

  constructor(options: WatcherOptions) {
    this.onGone = options.onGone
    this.meetingPlatform = options.meetingPlatform ?? null
    this.getWindowSources = options.getWindowSources ?? defaultGetWindowSources
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.absenceDebounce = options.absenceDebounce ?? DEFAULT_ABSENCE_DEBOUNCE
  }

  async start(): Promise<void> {
    let present: Set<DetectablePlatform>
    try {
      present = detectMeetingWindowPlatforms(await this.getWindowSources())
    } catch (err) {
      // Enumeration failed at start (e.g. Screen Recording not yet granted) —
      // stay inert and let the other auto-stop triggers handle this session.
      console.warn('[WindowWatcher] Initial window enumeration failed; watcher inert:', err)
      return
    }

    if (
      this.meetingPlatform &&
      this.meetingPlatform !== 'other' &&
      present.has(this.meetingPlatform as DetectablePlatform)
    ) {
      this.watchedPlatforms = new Set([this.meetingPlatform as DetectablePlatform])
    } else {
      // Unknown/'other' platform, or the named platform's window isn't open —
      // watch every meeting window that IS open at start.
      this.watchedPlatforms = present
    }

    if (this.watchedPlatforms.size === 0) {
      console.log('[WindowWatcher] No meeting window at start; inert (other triggers remain)')
      return
    }
    console.log('[WindowWatcher] Watching:', [...this.watchedPlatforms].join(', '))

    this.poller = setInterval(() => {
      void this.poll()
    }, this.pollIntervalMs)
  }

  /** Signal B: the captured window's video track ended (forwarded from renderer). */
  notifyTrackEnded(): void {
    if (this.stopped) return
    console.log('[WindowWatcher] track.ended received — reporting window gone')
    this.onGone()
  }

  stop(): void {
    this.stopped = true
    if (this.poller) {
      clearInterval(this.poller)
      this.poller = null
    }
  }

  private async poll(): Promise<void> {
    if (this.stopped || this.inFlight) return
    this.inFlight = true
    try {
      const present = detectMeetingWindowPlatforms(await this.getWindowSources())
      const allGone = [...this.watchedPlatforms].every((p) => !present.has(p))
      if (allGone) {
        this.absenceCount += 1
        if (this.absenceCount === this.absenceDebounce) {
          console.log(`[WindowWatcher] Watched window absent ${this.absenceCount} polls — gone`)
        }
        if (this.absenceCount >= this.absenceDebounce) this.onGone()
      } else {
        this.absenceCount = 0 // reappeared (tab switch / transient glitch)
      }
    } catch {
      // A flaky enumeration tick must not look like "window gone" — reset.
      this.absenceCount = 0
    } finally {
      this.inFlight = false
    }
  }
}
