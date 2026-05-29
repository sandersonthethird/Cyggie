// =============================================================================
// transcribe-job.ts — gateway-side background transcription pipeline.
//
// Lifecycle (M3 happy path):
//
//   submitTranscribeJob()
//     ├─ Read audio file from disk
//     ├─ POST → Deepgram batch /v1/listen?callback=…&secret=…
//     ├─ Persist `meetings.deepgram_request_id` so the on-boot reconciler can
//     │  recover this job if the gateway restarts before the webhook lands
//     └─ Register an in-memory finalize-pending Promise (cleared on webhook)
//
//   handleDeepgramWebhook()
//     ├─ Verify the callback secret (constant-time compare)
//     ├─ Extract utterances → segments + speaker_map
//     ├─ UPDATE meetings status='transcribed', transcript_segments, speaker_map
//     ├─ Read the session's apns_device_token; send transcription-ready push
//     ├─ On APNs 410 Unregistered: NULL the session token (cleanup)
//     └─ removePending('transcribe', meetingId)
//
//   reconcileStuckJobs()  (called once on gateway boot)
//     ├─ SELECT meetings WHERE status='recording' AND deepgram_request_id IS NOT NULL
//     │  AND created_at > now() - interval '24 hours'
//     ├─ For each, GET https://api.deepgram.com/v1/listen/<request_id>
//     │  - done → persist transcript via the same code path as the webhook
//     │  - still queued/processing → leave it; a future webhook will land
//     │  - rejected/expired → UPDATE status='error'
//     └─ Self-heals jobs lost to gateway restart.
// =============================================================================

import { eq, and, isNotNull, sql } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import { getDb } from '../db'
import { initApnsClient } from '../push/apns'
import { addPending, removePending } from '@cyggie/services/recording/pending-finalizations'
import {
  mapDeepgramUtterancesToSegments,
  buildGenericSpeakerMap,
  type DeepgramBatchResult,
} from '@cyggie/services/recording/deepgram-mapping'
import type { GatewayEnv } from '../env'
import { readFile } from 'node:fs/promises'
import { timingSafeEqual } from 'node:crypto'
import { Sentry } from '../sentry'
import { resolveDeepgramKey } from '../llm/resolve-key'

// Drizzle return type for getMeetingByRequestId / getMeetingForFinalize.
// Inlined locally rather than imported to keep this module self-contained.
interface MeetingForFinalize {
  id: string
  userId: string
  title: string
  deepgramRequestId: string | null
}

// ─── Debug ring buffer for last few Deepgram submit events ────────────────
// Persisted in-memory so /_debug/last-deepgram-errors can read them out
// without re-deriving from logs (Fly's log endpoint is flaky for this).
// Capped + non-PII (no audio content beyond ~32 bytes total).
//
// `outcome` differentiates failed submits (status 4xx/5xx) from successful
// ones (status 200 + a request_id). Successful entries let us diagnose
// "submit succeeded but transcript was empty" cases — silent recordings
// from the iOS Simulator typically produce a tiny M4A (~5-10KB) while real
// speech at 32kbps AAC is ~4KB/sec.

export interface DeepgramErrorRecord {
  at: string
  outcome: 'error' | 'success'
  meetingId: string
  status: number
  deepgramBody: string
  audioBytes: number
  audioHeadHex: string
  audioHeadAscii: string
  audioMidHex?: string
  submitUrl: string
}

const deepgramErrorRing: DeepgramErrorRecord[] = []
const DEEPGRAM_ERROR_RING_SIZE = 10

export function getRecentDeepgramErrors(): DeepgramErrorRecord[] {
  return deepgramErrorRing.slice().reverse()
}

function recordDeepgramError(r: DeepgramErrorRecord): void {
  deepgramErrorRing.push(r)
  if (deepgramErrorRing.length > DEEPGRAM_ERROR_RING_SIZE) {
    deepgramErrorRing.shift()
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function submitTranscribeJob(args: {
  env: GatewayEnv
  meetingId: string
  audioFilePath: string
}): Promise<{ requestId: string | null; error?: string }> {
  const { env, meetingId, audioFilePath } = args
  const db = getDb(env.GATEWAY_DATABASE_URL)

  // T32 — resolve the user's Deepgram key from user_credentials so each user
  // bills against their own account. PR-A: env.DEEPGRAM_API_KEY remains as a
  // fallback until Sandy's row lands via desktop backfill. PR-B: env removed.
  const meetingForKey = await db.query.meetings.findFirst({
    where: eq(schema.meetings.id, meetingId),
    columns: { userId: true },
  })
  if (!meetingForKey) {
    return { requestId: null, error: 'meeting_not_found' }
  }
  const deepgramKey = await resolveDeepgramKey(env, meetingForKey.userId)
  if (!deepgramKey) {
    console.error('[transcribe] no Deepgram key for user', {
      meetingId,
      userId: meetingForKey.userId,
    })
    Sentry.captureMessage('Deepgram key missing — user_credentials + env fallback both empty', {
      level: 'error',
      extra: { meetingId, userId: meetingForKey.userId },
    })
    return { requestId: null, error: 'deepgram_key_missing' }
  }

  // Build the callback URL with the shared secret. Without the secret param the
  // webhook handler rejects the request, so an attacker forging a callback
  // can't poison a meeting's transcript.
  const callbackUrl = new URL('/recordings/deepgram-webhook', publicBaseUrl(env))
  callbackUrl.searchParams.set('meetingId', meetingId)
  callbackUrl.searchParams.set('secret', env.DEEPGRAM_WEBHOOK_SECRET)

  const submitUrl = new URL('https://api.deepgram.com/v1/listen')
  submitUrl.searchParams.set('model', 'nova-3')
  submitUrl.searchParams.set('diarize', 'true')
  submitUrl.searchParams.set('smart_format', 'true')
  submitUrl.searchParams.set('utterances', 'true')
  submitUrl.searchParams.set('punctuate', 'true')
  submitUrl.searchParams.set('callback', callbackUrl.toString())
  // NOTE: don't send `callback_method` — Deepgram deprecated that param and
  // current API returns 400 "Invalid query string" if it's present.
  // Callbacks always fire POST now.

  let requestId: string | null = null
  try {
    const audio = await readFile(audioFilePath)
    console.log('[transcribe] submitting to Deepgram', {
      meetingId,
      audioBytes: audio.byteLength,
      submitUrl: submitUrl.toString(),
    })
    // Content-Type is M4A (MPEG-4 audio container with AAC codec inside) —
    // that's what expo-av's IOSOutputFormat.MPEG4AAC actually produces, NOT
    // raw .aac stream. Mismatched Content-Type causes Deepgram to fail
    // container detection. The file extension on disk is also `.aac` for
    // historical reasons; the bytes are M4A regardless.
    const res = await fetch(submitUrl.toString(), {
      method: 'POST',
      headers: {
        Authorization: `Token ${deepgramKey}`,
        'Content-Type': 'audio/mp4',
      },
      body: audio,
    })
    if (!res.ok) {
      const errBody = await res.text().catch(() => '<no body>')
      // Sniff first 16 bytes of the audio so we can verify the container
      // header in Sentry without needing the audio file itself. Valid M4A
      // starts with `....ftypM4A ` (or `....ftypmp42`/`isom`). Raw AAC ADTS
      // starts with `FF F1`/`FF F9`. CAF starts with `caff`.
      const audioHeadHex = Array.from(audio.subarray(0, 16))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(' ')
      const audioHeadAscii = Array.from(audio.subarray(0, 16))
        .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.'))
        .join('')
      console.error('[transcribe] Deepgram submit failed:', {
        meetingId,
        status: res.status,
        body: errBody.slice(0, 500),
        audioBytes: audio.byteLength,
        audioHeadHex,
        audioHeadAscii,
      })
      // T32 PR-B — distinguish 401 (user's Deepgram key invalid/revoked) from
      // other non-2xx so an "auth broken" alert can fire without noise from
      // payload errors. Tag the event for easier Sentry filtering.
      const isAuthFailure = res.status === 401 || res.status === 403
      Sentry.captureMessage(
        isAuthFailure
          ? 'Deepgram authentication failed (user key invalid/revoked)'
          : 'Deepgram submit returned non-2xx',
        {
          level: 'error',
          tags: isAuthFailure
            ? { deepgram_unauthorized: 'true', userId: meetingForKey.userId }
            : undefined,
          extra: {
            meetingId,
            userId: meetingForKey.userId,
            status: res.status,
            deepgramBody: errBody.slice(0, 2000),
            audioBytes: audio.byteLength,
            audioHeadHex,
            audioHeadAscii,
            submitUrl: submitUrl.toString(),
          },
        },
      )
      recordDeepgramError({
        at: new Date().toISOString(),
        outcome: 'error',
        meetingId,
        status: res.status,
        deepgramBody: errBody.slice(0, 2000),
        audioBytes: audio.byteLength,
        audioHeadHex,
        audioHeadAscii,
        submitUrl: submitUrl.toString(),
      })
      await markMeetingError(db, meetingId, `deepgram_${res.status}`)
      return { requestId: null, error: `deepgram_${res.status}` }
    }
    const body = (await res.json()) as { request_id?: string }
    requestId = body.request_id ?? null

    // Record successful submits too, so /_debug/last-deepgram-errors lets us
    // diagnose "transcribed but empty transcript" — typically caused by a
    // silent simulator recording. Mid-file byte sample helps tell encoded
    // silence from real speech without decoding the AAC.
    const audioHeadHex = Array.from(audio.subarray(0, 16))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' ')
    const audioHeadAscii = Array.from(audio.subarray(0, 16))
      .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.'))
      .join('')
    const mid = Math.max(0, Math.floor(audio.byteLength / 2) - 16)
    const audioMidHex = Array.from(audio.subarray(mid, mid + 32))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' ')
    recordDeepgramError({
      at: new Date().toISOString(),
      outcome: 'success',
      meetingId,
      status: res.status,
      deepgramBody: `request_id=${requestId ?? '<none>'}`,
      audioBytes: audio.byteLength,
      audioHeadHex,
      audioHeadAscii,
      audioMidHex,
      submitUrl: submitUrl.toString(),
    })
  } catch (err) {
    console.error('[transcribe] Deepgram submit threw:', {
      meetingId,
      err: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack?.slice(0, 500) : undefined,
    })
    await markMeetingError(db, meetingId, 'submit_failed')
    return { requestId: null, error: 'submit_failed' }
  }

  if (requestId) {
    await db
      .update(schema.meetings)
      .set({ deepgramRequestId: requestId, updatedAt: new Date() })
      .where(eq(schema.meetings.id, meetingId))
  }

  // Register a no-op finalize-pending so getPendingForQuit() can wait for the
  // webhook on graceful shutdown. The webhook handler resolves it.
  let resolveFn: () => void = () => {}
  const finalizePromise = new Promise<void>((res) => {
    resolveFn = res
  })
  addPending('transcribe', meetingId, finalizePromise)
  // Stash the resolver on a module-level map keyed by meetingId so the webhook
  // can flip it. In-memory only — survives only within a single gateway process.
  resolverByMeetingId.set(meetingId, resolveFn)

  return { requestId }
}

const resolverByMeetingId = new Map<string, () => void>()

export async function handleDeepgramWebhook(args: {
  env: GatewayEnv
  meetingId: string
  providedSecret: string
  deepgramPayload: unknown
}): Promise<{ ok: boolean; status: number; reason?: string }> {
  const { env, meetingId, providedSecret, deepgramPayload } = args

  // Constant-time secret compare. Reject early; no DB write.
  if (!secretsMatch(providedSecret, env.DEEPGRAM_WEBHOOK_SECRET)) {
    return { ok: false, status: 401, reason: 'invalid_secret' }
  }

  await persistTranscriptAndPush(env, meetingId, deepgramPayload as DeepgramBatchResult)

  // Resolve the finalize-pending promise so getPendingForQuit() unblocks.
  const resolve = resolverByMeetingId.get(meetingId)
  if (resolve) {
    resolve()
    resolverByMeetingId.delete(meetingId)
  }
  removePending('transcribe', meetingId)

  return { ok: true, status: 200 }
}

/**
 * On gateway boot: scan for meetings that were transcribing when the previous
 * process died. Self-heals by polling Deepgram once for each stuck job.
 */
export async function reconcileStuckJobs(env: GatewayEnv): Promise<{ checked: number }> {
  const db = getDb(env.GATEWAY_DATABASE_URL)
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const stuck = await db
    .select({
      id: schema.meetings.id,
      userId: schema.meetings.userId,
      title: schema.meetings.title,
      deepgramRequestId: schema.meetings.deepgramRequestId,
    })
    .from(schema.meetings)
    .where(
      and(
        eq(schema.meetings.status, 'recording'),
        isNotNull(schema.meetings.deepgramRequestId),
        sql`${schema.meetings.createdAt} > ${cutoff}`,
      ),
    )

  for (const m of stuck) {
    if (!m.deepgramRequestId) continue
    try {
      // T32 — per-user Deepgram key. Skip the meeting if the user has no key
      // (and env fallback is gone in PR-B); next reconcile pass tries again
      // after Sandy's desktop pushes the key on next launch.
      const deepgramKey = await resolveDeepgramKey(env, m.userId)
      if (!deepgramKey) {
        console.warn('[reconcile] no Deepgram key for user; skipping', {
          meetingId: m.id,
          userId: m.userId,
        })
        continue
      }
      const res = await fetch(
        `https://api.deepgram.com/v1/listen/${encodeURIComponent(m.deepgramRequestId)}`,
        { headers: { Authorization: `Token ${deepgramKey}` } },
      )
      if (res.status === 404) {
        // Deepgram never had it (request_id forgotten) OR job expired.
        await markMeetingError(db, m.id, 'deepgram_not_found')
        continue
      }
      if (!res.ok) {
        // Transient error — leave the row; next reconcile pass tries again.
        continue
      }
      const payload = (await res.json()) as DeepgramBatchResult & { job_status?: string }
      const jobStatus = payload.job_status
      if (jobStatus === 'queued' || jobStatus === 'processing') {
        // Still in flight; webhook should still arrive. Leave it.
        continue
      }
      // Completed → persist via the same path the webhook uses.
      await persistTranscriptAndPush(env, m.id, payload)
    } catch (err) {
      console.error('[reconcile] failed for', m.id, err)
    }
  }

  return { checked: stuck.length }
}

// ─── Core: persist transcript + send push ───────────────────────────────────

async function persistTranscriptAndPush(
  env: GatewayEnv,
  meetingId: string,
  payload: DeepgramBatchResult,
): Promise<void> {
  const db = getDb(env.GATEWAY_DATABASE_URL)

  // Deepgram's webhook fires for BOTH success and failure paths. The error
  // payload has no `results` field (it's something like
  // { type: 'JobFailedNotification', request_id, err_code, err_msg }).
  // Guard accordingly so the handler doesn't crash on legit failure callbacks
  // — observed when a sub-second / silent audio file is rejected by
  // Deepgram's transcription pipeline.
  if (!payload || typeof payload !== 'object' || !payload.results) {
    const errPayload = payload as unknown as {
      err_code?: string
      err_msg?: string
      error?: string
      type?: string
    }
    console.warn('[transcribe] webhook payload has no `results` — Deepgram error path', {
      meetingId,
      err_code: errPayload?.err_code,
      err_msg: errPayload?.err_msg,
      error: errPayload?.error,
      type: errPayload?.type,
    })
    await markMeetingError(db, meetingId, errPayload?.err_msg ?? 'deepgram_callback_error')
    return
  }

  const segments = mapDeepgramUtterancesToSegments(payload)
  const speakerMap = buildGenericSpeakerMap(payload)
  const durationSeconds = Math.floor(payload.metadata?.duration ?? 0)

  // Branch on segment count. Deepgram returns a valid 2xx with an empty
  // utterances array when the audio was processed but no speech was
  // detected — silence, near-silence, or sub-threshold input. Mobile shows
  // a "no speech detected" banner so the user can discard the recording
  // rather than seeing a confusing "transcribed" meeting with empty body.
  const isEmpty = segments.length === 0
  const newStatus = isEmpty ? 'empty' : 'transcribed'

  // Read first — we need userId/title for the APNs push AND the stored
  // lamport so the update can mint a strictly-greater value. Combined
  // into one round-trip.
  const meeting = await db.query.meetings.findFirst({
    where: eq(schema.meetings.id, meetingId),
    columns: { id: true, userId: true, title: true, lamport: true },
  })
  if (!meeting) return

  // Mobile's /sync/pull filters `WHERE lamport > since`. If this update
  // doesn't advance lamport, mobile's delta-sync silently misses the
  // transcript even though it's persisted in Neon. Same BigInt
  // max(stored, wallclock)+1 pattern as POST /meetings/:id/enhance
  // (routes/meetings.ts:883-887).
  const storedLamport = BigInt(meeting.lamport ?? '0')
  const wallLamport = BigInt(Date.now())
  const nextLamport = ((storedLamport > wallLamport ? storedLamport : wallLamport) + 1n).toString()

  await db
    .update(schema.meetings)
    .set({
      status: newStatus,
      transcriptSegments: segments,
      speakerMap,
      speakerCount: Object.keys(speakerMap).length,
      durationSeconds,
      lamport: nextLamport,
      updatedAt: new Date(),
    })
    .where(eq(schema.meetings.id, meetingId))

  // Send APNs to every active session for this user that has a registered
  // device token. We push to ALL device tokens (the user might be recording on
  // one phone and reading transcripts on another). 410-cleanup keeps the table
  // honest over time.
  const sessions = await db
    .select({
      id: schema.sessions.id,
      apnsDeviceToken: schema.sessions.apnsDeviceToken,
    })
    .from(schema.sessions)
    .where(
      and(
        eq(schema.sessions.userId, meeting.userId),
        isNotNull(schema.sessions.apnsDeviceToken),
        sql`${schema.sessions.revokedAt} IS NULL`,
      ),
    )

  if (sessions.length === 0) return

  const apns = initApnsClient(env)
  for (const s of sessions) {
    if (!s.apnsDeviceToken) continue
    const result = isEmpty
      ? await apns.sendTranscriptionEmpty({
          deviceToken: s.apnsDeviceToken,
          meetingId: meeting.id,
          title: meeting.title,
        })
      : await apns.sendTranscriptionReady({
          deviceToken: s.apnsDeviceToken,
          meetingId: meeting.id,
          title: meeting.title,
        })
    for (const deadToken of result.unregistered) {
      await db
        .update(schema.sessions)
        .set({
          apnsDeviceToken: null,
          apnsEnvironment: null,
          apnsTokenUpdatedAt: new Date(),
        })
        .where(eq(schema.sessions.apnsDeviceToken, deadToken))
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function markMeetingError(
  db: ReturnType<typeof getDb>,
  meetingId: string,
  _reason: string,
): Promise<void> {
  // Bump lamport so mobile's /sync/pull sees the status transition. Without
  // this the row stays at its pre-recording lamport and mobile keeps
  // showing 'recording' indefinitely.
  const existing = await db.query.meetings.findFirst({
    where: eq(schema.meetings.id, meetingId),
    columns: { lamport: true },
  })
  if (!existing) return
  const storedLamport = BigInt(existing.lamport ?? '0')
  const wallLamport = BigInt(Date.now())
  const nextLamport = ((storedLamport > wallLamport ? storedLamport : wallLamport) + 1n).toString()
  await db
    .update(schema.meetings)
    .set({ status: 'error', lamport: nextLamport, updatedAt: new Date() })
    .where(eq(schema.meetings.id, meetingId))
}

function secretsMatch(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
}

function publicBaseUrl(env: GatewayEnv): string {
  // For now, derive from GOOGLE_OAUTH_REDIRECT_URI which is the same gateway
  // host. In prod: https://cyggie-gateway.fly.dev.
  // TODO: add a dedicated PUBLIC_BASE_URL env var when more callsites need it.
  const u = new URL(env.GOOGLE_OAUTH_REDIRECT_URI)
  return `${u.protocol}//${u.host}`
}

/** Test-only seam: reset the in-memory resolver map between cases. */
export function _resetTranscribeJobForTesting(): void {
  resolverByMeetingId.clear()
}
