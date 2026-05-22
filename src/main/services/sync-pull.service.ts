// =============================================================================
// sync-pull.service.ts — desktop pull-side counterpart to SyncAgent (push).
//
// Polls `GET /sync/pull?since=<lastPulledLamport>` and feeds returned rows
// into applyRemoteMeetings(). Lives alongside SyncAgent in sync-bootstrap.ts.
//
// STATE MACHINE
//
//      ┌─────────┐  tick (60s) OR triggerPull() OR app focus
//      │  IDLE   │ ─────────────────────────────────────────┐
//      └────┬────┘                                          ▼
//           ▲                                       ┌──────────────┐
//           │     push state !== 'idle'             │ MUTEX_CHECK  │
//           │      ─────────────────────────────────│  (Issue 2A)  │
//           │     skip + log + retry next tick      └──────┬───────┘
//           │                                              │
//           │                                              ▼  push idle
//           │                                       ┌──────────────┐
//           │       2xx                             │   PULLING    │
//           │  ◀────────  (apply rows in tx)        └──────┬───────┘
//           │       401 → sign-out chain                   │
//           │       5xx / network → backoff curve          ▼
//           │                                       GET /sync/pull
//           └───────────────────────────────────────────────┘
//
// MUTEX: push and pull share the SyncAgent class instance reference; we
// call agent.getState() at the top of each tick. If push is FLUSHING /
// ACK_PENDING / BACKING_OFF / etc., we drop the pull tick. Pull is
// idempotent so dropping costs at most 60s of staleness.
//
// LAMPORT: applyRemoteMeetings bumps sync_state.last_pushed_lamport
// alongside last_pulled_lamport so nextLamport()'s next mint is above
// any incoming high-water (closes Issue 1A from review).
//
// =============================================================================

import type Database from 'better-sqlite3'
import { applyRemoteMeetings, type PulledMeetingRow } from './sync-remote-apply'
import type { SyncAgent } from './sync-agent'

const PULL_INTERVAL_MS = 60_000
const BACKOFF_INITIAL_MS = 2_000
const BACKOFF_MAX_MS = 60_000

export type PullState =
  | 'idle'
  | 'pulling'
  | 'backing_off'
  | 'paused_no_auth'

export interface PullStateSnapshot {
  state: PullState
  lastPulledAt: number | null
  lastPulledLamport: string
  lastError: string | null
  nextRetryAt: number | null
}

export interface PullResponse {
  meetings: PulledMeetingRow[]
  serverLamport: string
}

export interface PullTransport {
  pull(args: { deviceId: string; since: string }): Promise<PullResponse>
}

export interface SyncPullServiceConfig {
  db: Database.Database
  getDeviceId: () => string
  getUserId: () => string | null
  getAccessToken: () => Promise<string | null>
  syncAgent: SyncAgent
  transport: PullTransport
  /** Wall-clock + setInterval injectable for tests. */
  clock?: {
    setInterval: (cb: () => void, ms: number) => ReturnType<typeof setInterval>
    clearInterval: (h: ReturnType<typeof setInterval>) => void
    now: () => number
  }
  /** Test seam — speed up the periodic tick in tests. */
  tickIntervalMs?: number
  /** Optional IPC callback for renderer cache invalidation (Issue 5A).
   *  Production wiring lives in sync-bootstrap.ts. */
  onMeetingsApplied?: (ids: string[]) => void
  /** Optional state-change subscriber (Issue 5A SYNC_PULL_STATUS_CHANGED). */
  onStateChange?: (snapshot: PullStateSnapshot) => void
  /** Optional pino logger. */
  log?: {
    info?: (payload: Record<string, unknown>, msg: string) => void
    warn?: (payload: Record<string, unknown>, msg: string) => void
    error?: (payload: Record<string, unknown>, msg: string) => void
  }
}

export class SyncPullService {
  private cfg: SyncPullServiceConfig
  private state: PullState = 'idle'
  private tickHandle: ReturnType<typeof setInterval> | null = null
  private running = false
  private inFlight: Promise<void> | null = null
  private backoffMs = BACKOFF_INITIAL_MS
  private lastPulledAt: number | null = null
  private lastError: string | null = null
  private nextRetryAt: number | null = null

  constructor(cfg: SyncPullServiceConfig) {
    this.cfg = cfg
  }

  start(): void {
    if (this.running) return
    this.running = true
    const intervalMs = this.cfg.tickIntervalMs ?? PULL_INTERVAL_MS
    const c = this.clock()
    this.tickHandle = c.setInterval(() => {
      void this.tick()
    }, intervalMs)
    // Fire an immediate pull on start so signed-in transitions don't wait
    // for the first 60s tick.
    void this.tick()
  }

  stop(): void {
    if (!this.running) return
    this.running = false
    if (this.tickHandle) {
      this.clock().clearInterval(this.tickHandle)
      this.tickHandle = null
    }
  }

  /** External trigger — bootstrap calls this on AppState 'active' / focus. */
  triggerPull(): void {
    void this.tick()
  }

  snapshot(): PullStateSnapshot {
    return {
      state: this.state,
      lastPulledAt: this.lastPulledAt,
      lastPulledLamport: this.readLastPulledLamport(),
      lastError: this.lastError,
      nextRetryAt: this.nextRetryAt,
    }
  }

  /** Test seam — observable in-flight promise. */
  async waitForIdle(): Promise<void> {
    while (this.inFlight) {
      await this.inFlight
    }
  }

  // -- internals --------------------------------------------------------------

  private async tick(): Promise<void> {
    if (!this.running) return
    if (this.inFlight) return // single-flight against rapid retriggers
    if (this.cfg.syncAgent.getState() !== 'idle') {
      // Issue 2A — push is mid-flight; drop the tick.
      this.cfg.log?.info?.(
        { metric: 'sync.pull.skipped_push_busy', pushState: this.cfg.syncAgent.getState() },
        'sync.pull skipped tick — push busy',
      )
      return
    }
    const userId = this.cfg.getUserId()
    if (!userId) {
      this.setState('paused_no_auth')
      return
    }
    this.inFlight = this.runOnce(userId)
    try {
      await this.inFlight
    } finally {
      this.inFlight = null
    }
  }

  private async runOnce(userId: string): Promise<void> {
    const since = this.readLastPulledLamport()
    const deviceId = this.cfg.getDeviceId()
    this.setState('pulling')
    this.cfg.log?.info?.(
      { metric: 'sync.pull.start', since, deviceId, userId },
      'sync.pull starting',
    )

    let response: PullResponse
    try {
      response = await this.cfg.transport.pull({ deviceId, since })
    } catch (err) {
      const status = isHttpError(err) ? err.status : null
      this.lastError = err instanceof Error ? err.message : String(err)
      if (status === 401) {
        // Caller signs out via the same chain push uses (auth handler).
        // We just back off here; the auth subsystem flips userId to null
        // and our next tick will go paused.
        this.cfg.log?.warn?.(
          { metric: 'sync.pull.401', error: this.lastError },
          'sync.pull 401',
        )
        this.scheduleBackoff()
        return
      }
      this.cfg.log?.warn?.(
        { metric: 'sync.pull.error', error: this.lastError, status },
        'sync.pull error',
      )
      this.scheduleBackoff()
      return
    }

    // Apply rows (chunked 50-at-a-time inside applyRemoteMeetings).
    let result: { appliedIds: string[]; skippedLowLamport: number; skippedPreValidation: number }
    try {
      result = applyRemoteMeetings(
        this.cfg.db,
        deviceId,
        userId,
        response.meetings,
        {
          onApplied: this.cfg.onMeetingsApplied,
          ...(this.cfg.log ? { log: this.cfg.log } : {}),
        },
      )
    } catch (err) {
      // Top-level apply failure (something other than per-sub-batch
      // rollback, which is handled inside applyRemoteMeetings). Back off.
      this.lastError = err instanceof Error ? err.message : String(err)
      this.cfg.log?.error?.(
        { metric: 'sync.pull.apply_error', error: this.lastError },
        'sync.pull apply crashed',
      )
      this.scheduleBackoff()
      return
    }

    this.lastPulledAt = this.clock().now()
    this.lastError = null
    this.backoffMs = BACKOFF_INITIAL_MS
    this.nextRetryAt = null
    this.setState('idle')
    this.cfg.log?.info?.(
      {
        metric: 'sync.pull.complete',
        rowCount: response.meetings.length,
        appliedCount: result.appliedIds.length,
        skippedLowLamport: result.skippedLowLamport,
        skippedPreValidation: result.skippedPreValidation,
        serverLamport: response.serverLamport,
      },
      'sync.pull complete',
    )
  }

  private scheduleBackoff(): void {
    this.setState('backing_off')
    const c = this.clock()
    this.nextRetryAt = c.now() + this.backoffMs
    const delay = this.backoffMs
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS)
    setTimeout(() => {
      if (!this.running) return
      this.setState('idle')
      this.nextRetryAt = null
      void this.tick()
    }, delay)
  }

  private setState(state: PullState): void {
    if (this.state === state) return
    this.state = state
    this.cfg.onStateChange?.(this.snapshot())
  }

  private readLastPulledLamport(): string {
    const row = this.cfg.db
      .prepare('SELECT last_pulled_lamport FROM sync_state WHERE device_id = ?')
      .get(this.cfg.getDeviceId()) as { last_pulled_lamport: string } | undefined
    return row?.last_pulled_lamport ?? '0'
  }

  private clock() {
    return (
      this.cfg.clock ?? {
        setInterval,
        clearInterval,
        now: Date.now,
      }
    )
  }
}

function isHttpError(err: unknown): err is { status: number } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    typeof (err as { status: unknown }).status === 'number'
  )
}
