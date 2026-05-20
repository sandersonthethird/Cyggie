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
import type { GatewayEnv } from '../env'
import { readFile } from 'node:fs/promises'
import { timingSafeEqual } from 'node:crypto'

// ─── Deepgram batch types (subset we actually use) ───────────────────────────

interface DeepgramWord {
  word: string
  start: number
  end: number
  confidence: number
  speaker?: number
  punctuated_word?: string
}

interface DeepgramUtterance {
  start: number
  end: number
  confidence: number
  channel: number
  transcript: string
  words: DeepgramWord[]
  speaker?: number
}

interface DeepgramBatchResult {
  metadata?: {
    request_id?: string
    duration?: number
    channels?: number
  }
  results: {
    channels: Array<{
      alternatives: Array<{
        transcript: string
        words: DeepgramWord[]
      }>
    }>
    utterances?: DeepgramUtterance[]
  }
}

// Drizzle return type for getMeetingByRequestId / getMeetingForFinalize.
// Inlined locally rather than imported to keep this module self-contained.
interface MeetingForFinalize {
  id: string
  userId: string
  title: string
  deepgramRequestId: string | null
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function submitTranscribeJob(args: {
  env: GatewayEnv
  meetingId: string
  audioFilePath: string
}): Promise<{ requestId: string | null; error?: string }> {
  const { env, meetingId, audioFilePath } = args
  const db = getDb(env.GATEWAY_DATABASE_URL)

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
    // Content-Type is M4A (MPEG-4 audio container with AAC codec inside) —
    // that's what expo-av's IOSOutputFormat.MPEG4AAC actually produces, NOT
    // raw .aac stream. Mismatched Content-Type causes Deepgram to fail
    // container detection. The file extension on disk is also `.aac` for
    // historical reasons; the bytes are M4A regardless.
    const res = await fetch(submitUrl.toString(), {
      method: 'POST',
      headers: {
        Authorization: `Token ${env.DEEPGRAM_API_KEY}`,
        'Content-Type': 'audio/mp4',
      },
      body: audio,
    })
    if (!res.ok) {
      const errBody = await res.text().catch(() => '<no body>')
      console.error('[transcribe] Deepgram submit failed:', {
        meetingId,
        status: res.status,
        body: errBody.slice(0, 500),
      })
      await markMeetingError(db, meetingId, `deepgram_${res.status}`)
      return { requestId: null, error: `deepgram_${res.status}` }
    }
    const body = (await res.json()) as { request_id?: string }
    requestId = body.request_id ?? null
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
      const res = await fetch(
        `https://api.deepgram.com/v1/listen/${encodeURIComponent(m.deepgramRequestId)}`,
        { headers: { Authorization: `Token ${env.DEEPGRAM_API_KEY}` } },
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

  const segments = extractSegments(payload)
  const speakerMap = buildSpeakerMap(payload)
  const durationSeconds = Math.floor(payload.metadata?.duration ?? 0)

  await db
    .update(schema.meetings)
    .set({
      status: 'transcribed',
      transcriptSegments: segments,
      speakerMap,
      speakerCount: Object.keys(speakerMap).length,
      durationSeconds,
      updatedAt: new Date(),
    })
    .where(eq(schema.meetings.id, meetingId))

  const meeting = await db.query.meetings.findFirst({
    where: eq(schema.meetings.id, meetingId),
    columns: { id: true, userId: true, title: true },
  })
  if (!meeting) return

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
    const result = await apns.sendTranscriptionReady({
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
  await db
    .update(schema.meetings)
    .set({ status: 'error', updatedAt: new Date() })
    .where(eq(schema.meetings.id, meetingId))
}

function extractSegments(payload: DeepgramBatchResult): unknown[] {
  // For V1 we persist the utterances array as-is (Deepgram's speaker-segmented
  // output). The mobile + desktop renderers consume this shape directly.
  return payload.results.utterances ?? []
}

function buildSpeakerMap(payload: DeepgramBatchResult): Record<number, string> {
  // No calendar attendees on the mobile path → label generically. The user
  // can rename speakers from the meeting-detail UI (M5 territory).
  const speakerIds = new Set<number>()
  for (const utt of payload.results.utterances ?? []) {
    if (typeof utt.speaker === 'number') speakerIds.add(utt.speaker)
  }
  const map: Record<number, string> = {}
  for (const id of speakerIds) map[id] = `Speaker ${id + 1}`
  return map
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
