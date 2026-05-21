// =============================================================================
// boot.ts — wire the sync agent + conflict bus + drain triggers.
//
// Called once from the root layout when auth becomes signed_in. Safe to call
// repeatedly — configureSyncAgent overwrites the executor + handlers, and
// initDrainTriggers de-dups its setInterval/AppState bindings.
// =============================================================================

import { AppState, type AppStateStatus } from 'react-native'
import { apiFetchRaw } from '../api/client'
import { configureSyncAgent, drainNow, type PatchExecutor } from './agent'
import { publishConflict } from './conflict-bus'

let triggersInitialized = false
let intervalHandle: ReturnType<typeof setInterval> | null = null
let appStateSub: { remove: () => void } | null = null

const PERIODIC_DRAIN_MS = 30_000

// Yours-cache: when we enqueue, capture the value so a 409 reply can name
// "what you typed". The agent only receives `{meetingId, server}` from the
// PATCH; the original yours-value was already removed from the outbox by
// the time the conflict fires.
const lastYoursByMeetingId = new Map<string, string | null>()

export function rememberLastYours(meetingId: string, yours: string | null): void {
  lastYoursByMeetingId.set(meetingId, yours)
}

const patchExecutor: PatchExecutor = async (url, body) => {
  // Raw fetch — surfaces both 2xx + 4xx bodies. The gateway's 409 path
  // returns a full MeetingDetail (not the {error: {...}} envelope), so we
  // need the parsed body for conflict resolution.
  return apiFetchRaw(url, { method: 'PATCH', body })
}

export function initSync(): void {
  configureSyncAgent({
    patch: patchExecutor,
    onApplied: (meetingId) => {
      lastYoursByMeetingId.delete(meetingId)
    },
    onConflict: ({ meetingId, server }) => {
      const theirs = extractNotes(server)
      const serverLamport = extractLamport(server)
      publishConflict({
        meetingId,
        yours: lastYoursByMeetingId.get(meetingId) ?? null,
        theirs,
        serverLamport,
      })
    },
    onDLQ: () => {
      // Sentry hook would live here once we wire it up; for now the agent's
      // own log line is sufficient to diagnose in TestFlight.
    },
  })

  if (!triggersInitialized) {
    triggersInitialized = true
    intervalHandle = setInterval(() => {
      void drainNow()
    }, PERIODIC_DRAIN_MS)
    appStateSub = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active') void drainNow()
    })
  }
}

export function shutdownSync(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle)
    intervalHandle = null
  }
  if (appStateSub) {
    appStateSub.remove()
    appStateSub = null
  }
  triggersInitialized = false
}

function extractNotes(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const v = (body as { notes?: unknown }).notes
  if (typeof v === 'string') return v
  return null
}

function extractLamport(body: unknown): string {
  if (!body || typeof body !== 'object') return '0'
  const v = (body as { lamport?: unknown }).lamport
  return typeof v === 'string' ? v : '0'
}
