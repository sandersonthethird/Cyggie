// =============================================================================
// recordings.ts — M3 recording routes.
//
//   POST /recordings/upload           — authed; multipart audio + metadata.
//                                       Saves audio, inserts meetings row,
//                                       kicks off Deepgram batch submit.
//   POST /recordings/deepgram-webhook — public; secret-authed via query param.
//                                       Persists transcript + sends APNs push.
//   POST /devices/register-push       — authed; stores APNs device token on
//                                       the caller's session row.
// =============================================================================

import type { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { createId } from '@paralleldrive/cuid2'
import { eq, and, gte, sum, sql } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import { getDb } from '../db'
import { GatewayError } from '../plugins/error'
import type { GatewayEnv } from '../env'
import { submitTranscribeJob, handleDeepgramWebhook } from '../recording/transcribe-job'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export async function registerRecordingRoutes(
  app: FastifyInstance,
  env: GatewayEnv,
): Promise<void> {
  const fastifyTyped = app.withTypeProvider<ZodTypeProvider>()

  // ───────────────────────────────────────────────────────────────────────────
  // POST /recordings/upload  (authed, multipart)
  // ───────────────────────────────────────────────────────────────────────────
  app.route({
    method: 'POST',
    url: '/recordings/upload',
    handler: async (req, reply) => {
      const user = req.requireUser()
      const db = getDb(env.GATEWAY_DATABASE_URL)

      // Quota gate (per-user, calendar-month). One sum query; cheap. Race-y at
      // the boundary (two concurrent uploads at 99.5% each both pass) but for
      // V1 monthly minutes drift by a few percent is acceptable.
      const monthStart = startOfCurrentMonth()
      const [usageRow] = await db
        .select({ total: sum(schema.meetings.durationSeconds) })
        .from(schema.meetings)
        .where(
          and(
            eq(schema.meetings.userId, user.sub),
            gte(schema.meetings.createdAt, monthStart),
          ),
        )
      const usedSeconds = Number(usageRow?.total ?? 0)
      const capSeconds = env.RECORDING_QUOTA_MONTHLY_MINUTES * 60
      if (usedSeconds >= capSeconds) {
        throw new GatewayError({
          statusCode: 403,
          code: 'QUOTA_EXCEEDED',
          message: `Monthly recording quota exhausted (${env.RECORDING_QUOTA_MONTHLY_MINUTES} min cap; used ${Math.floor(usedSeconds / 60)} min).`,
        })
      }

      // Multipart parsing — provided by @fastify/multipart plugin registered in app.ts.
      const data = await (req as unknown as { file: () => Promise<unknown> }).file()
      if (!data) {
        throw new GatewayError({
          statusCode: 400,
          code: 'NO_AUDIO',
          message: 'Multipart request had no `audio` file part.',
        })
      }
      const filePart = data as {
        filename: string
        mimetype: string
        toBuffer(): Promise<Buffer>
        fields: Record<string, { value: string }>
      }

      // Extract optional title + calEventId + clientRecordedAt from multipart fields.
      const title = filePart.fields['title']?.value || defaultMeetingTitle()
      const calendarEventId = filePart.fields['calEventId']?.value || null
      const clientRecordedAtRaw = filePart.fields['clientRecordedAt']?.value
      const recordedAt = clientRecordedAtRaw ? new Date(clientRecordedAtRaw) : new Date()

      const audioBuffer = await filePart.toBuffer()
      if (audioBuffer.length > env.RECORDING_MAX_UPLOAD_BYTES) {
        throw new GatewayError({
          statusCode: 413,
          code: 'UPLOAD_TOO_LARGE',
          message: `Audio file too large (max ${env.RECORDING_MAX_UPLOAD_BYTES} bytes).`,
        })
      }

      // Persist audio. For V1 we write to OS tmp; Fly volumes / R2 is a
      // follow-up. The path is stored on the meeting row so the on-boot
      // reconciler (and future re-transcribe paths) can find the audio again.
      const meetingId = createId()
      // Save as .m4a — that's what expo-av actually produces (MPEG-4 audio
      // container with AAC codec inside). The extension is cosmetic for
      // Deepgram (it inspects the bytes, not the path) but consistency
      // matches what's on the wire.
      const audioDir = join(tmpdir(), 'cyggie-recordings', user.sub)
      await mkdir(audioDir, { recursive: true })
      const audioPath = join(audioDir, `${meetingId}.m4a`)
      await writeFile(audioPath, audioBuffer)

      // Mobile recordings are always impromptu (the user tapped Record FAB
      // from the Calendar tab). M5 will let them attach to a calendar event
      // post-hoc; for now `was_impromptu=true` is the truth.
      await db.insert(schema.meetings).values({
        id: meetingId,
        userId: user.sub,
        title,
        date: recordedAt,
        calendarEventId,
        recordingPath: audioPath,
        status: 'recording',
        wasImpromptu: true,
        createdByUserId: user.sub,
      })

      // Submit to Deepgram BEFORE responding 202. Two reasons:
      //
      //   1. Fly auto-stops idle machines aggressively. A fire-and-forget
      //      Promise that outlives the HTTP response gets SIGTERM'd mid-fetch
      //      — observed via meetings rows flipping to status='error' with
      //      deepgram_request_id=null and a ~300ms turnaround.
      //   2. The submit itself returns in ~1-2s — Deepgram returns the
      //      request_id immediately and processes the transcription on its
      //      side. Holding the request for that brief window is acceptable.
      //
      // After submitTranscribeJob resolves with a request_id, the row is
      // persisted; the webhook (or on-boot reconciler) handles the actual
      // transcript persistence + APNs push without needing this request to
      // stay open.
      const result = await submitTranscribeJob({
        env,
        meetingId,
        audioFilePath: audioPath,
      })
      if (result.error) {
        // submitTranscribeJob already called markMeetingError; surface a
        // clearer error to the client.
        throw new GatewayError({
          statusCode: 502,
          code: 'TRANSCRIBE_SUBMIT_FAILED',
          message: `Deepgram submit failed: ${result.error}`,
        })
      }

      return reply.code(202).send({ meetingId })
    },
  })

  // ───────────────────────────────────────────────────────────────────────────
  // POST /recordings/deepgram-webhook  (public, secret-authed)
  // ───────────────────────────────────────────────────────────────────────────
  fastifyTyped.route({
    method: 'POST',
    url: '/recordings/deepgram-webhook',
    schema: {
      querystring: z.object({
        meetingId: z.string().min(1),
        secret: z.string().min(1),
      }),
    },
    handler: async (req, reply) => {
      const { meetingId, secret } = req.query
      const result = await handleDeepgramWebhook({
        env,
        meetingId,
        providedSecret: secret,
        deepgramPayload: req.body,
      })
      if (!result.ok) {
        return reply.code(result.status).send({
          error: { code: result.reason ?? 'WEBHOOK_REJECTED', message: 'Webhook rejected' },
        })
      }
      return reply.code(200).send({ ok: true })
    },
  })

  // ───────────────────────────────────────────────────────────────────────────
  // POST /devices/register-push  (authed)
  // ───────────────────────────────────────────────────────────────────────────
  fastifyTyped.route({
    method: 'POST',
    url: '/devices/register-push',
    schema: {
      body: z.object({
        deviceToken: z.string().min(8).max(256),
        environment: z.enum(['sandbox', 'production']),
      }),
      response: { 200: z.object({ ok: z.literal(true) }) },
    },
    handler: async (req) => {
      const user = req.requireUser()
      const db = getDb(env.GATEWAY_DATABASE_URL)
      const { deviceToken, environment } = req.body

      // Tokens are per-session. The JWT carries the session id (sid); we
      // store the token on that exact row so sign-out (which revokes the
      // session) implicitly stops pushes to that token.
      await db
        .update(schema.sessions)
        .set({
          apnsDeviceToken: deviceToken,
          apnsEnvironment: environment,
          apnsTokenUpdatedAt: new Date(),
        })
        .where(eq(schema.sessions.id, user.sid))

      return { ok: true as const }
    },
  })
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function startOfCurrentMonth(): Date {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0))
}

function defaultMeetingTitle(): string {
  return `Meeting ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()}`
}
