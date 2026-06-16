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
import { insertImpromptuMeeting } from '../recording/insert-impromptu-meeting'
import { isUniqueViolation } from '../pg-errors'
import {
  submitTranscribeJob,
  handleDeepgramWebhook,
  getRecentDeepgramErrors,
} from '../recording/transcribe-job'
import { timingSafeEqual } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Client-minted ids are cuid2 (lowercase alphanumeric). Cap length defensively
// so a malformed/oversized `meetingId` field can't reach the meetings.id column.
const CLIENT_ID_RE = /^[a-z0-9]{1,32}$/

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
      //
      // Filter on `date` (the recorded-at column), not `created_at`. Re-uploading
      // or backfilling old audio should count against the month it was recorded,
      // not the month it was uploaded — otherwise a backlog flush burns the
      // current month's budget for audio Deepgram already transcribed (or for
      // audio that's months old and unrelated to current usage).
      const monthStart = startOfCurrentMonth()
      const [usageRow] = await db
        .select({ total: sum(schema.meetings.durationSeconds) })
        .from(schema.meetings)
        .where(
          and(
            eq(schema.meetings.userId, user.sub),
            gte(schema.meetings.date, monthStart),
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

      // Extract optional title + calEventId + clientRecordedAt + meetingId.
      const title = filePart.fields['title']?.value || defaultMeetingTitle()
      const calendarEventId = filePart.fields['calEventId']?.value || null
      const clientRecordedAtRaw = filePart.fields['clientRecordedAt']?.value
      const recordedAt = clientRecordedAtRaw ? new Date(clientRecordedAtRaw) : new Date()
      // Optional client-minted meeting id (impromptu pre-create / offline path).
      // When present we attach audio to (or create-if-absent) THIS row instead
      // of inserting a server-minted impromptu. Validate the format up front
      // (cuid2 shape) so a malformed id is rejected before we touch storage.
      const clientMeetingId = filePart.fields['meetingId']?.value || null
      if (clientMeetingId !== null && !CLIENT_ID_RE.test(clientMeetingId)) {
        throw new GatewayError({
          statusCode: 400,
          code: 'INVALID_MEETING_ID',
          message: 'meetingId is not a valid id.',
        })
      }

      const audioBuffer = await filePart.toBuffer()
      if (audioBuffer.length > env.RECORDING_MAX_UPLOAD_BYTES) {
        throw new GatewayError({
          statusCode: 413,
          code: 'UPLOAD_TOO_LARGE',
          message: `Audio file too large (max ${env.RECORDING_MAX_UPLOAD_BYTES} bytes).`,
        })
      }

      // Find-or-create the meeting row. Resolution order:
      //   1. clientMeetingId (impromptu pre-create / offline) — scoped to the
      //      caller. Found → attach audio. Absent → create-if-absent below
      //      with the client id (the pre-create may never have landed offline;
      //      a cancelled id never reaches here per the mobile cancel contract).
      //   2. calEventId — the scheduled-meeting path: a status='scheduled' row
      //      already exists for (user, calEventId); reuse it so pre-recording
      //      notes survive and we don't break the per-user UNIQUE on
      //      (user_id, calendar_event_id) (migration 0014).
      let existing: { id: string } | undefined
      if (clientMeetingId) {
        existing = await db.query.meetings.findFirst({
          where: and(
            eq(schema.meetings.id, clientMeetingId),
            eq(schema.meetings.userId, user.sub),
          ),
          columns: { id: true },
        })
      } else if (calendarEventId) {
        existing = await db.query.meetings.findFirst({
          where: and(
            eq(schema.meetings.userId, user.sub),
            eq(schema.meetings.calendarEventId, calendarEventId),
          ),
          columns: { id: true },
        })
      }
      // `meetingId` is the id we'll respond with and pass to Deepgram. It
      // starts as the existing row's id (if found), else the client-minted id
      // (create-if-absent), else a fresh server cuid (FAB impromptu). The
      // 23505-recovery branch below may swap it to a racer's id.
      let meetingId = existing?.id ?? clientMeetingId ?? createId()

      // Save as .m4a — that's what expo-av actually produces (MPEG-4 audio
      // container with AAC codec inside). The extension is cosmetic for
      // Deepgram (it inspects the bytes, not the path) but consistency
      // matches what's on the wire.
      const audioDir = join(tmpdir(), 'cyggie-recordings', user.sub)
      await mkdir(audioDir, { recursive: true })
      const audioPath = join(audioDir, `${meetingId}.m4a`)
      await writeFile(audioPath, audioBuffer)

      if (existing) {
        // Pre-existing scheduled meeting (from /meetings/from-calendar-event).
        // Flip into recording, attach the audio. Don't clobber notes/title —
        // the user may have set them ahead of the meeting.
        await db
          .update(schema.meetings)
          .set({
            recordingPath: audioPath,
            status: 'recording',
            updatedAt: new Date(),
            updatedByUserId: user.sub,
          })
          .where(eq(schema.meetings.id, meetingId))
      } else {
        // No prior row — fully impromptu (Record FAB outside a calendar slot),
        // an offline client-minted id whose pre-create never landed
        // (create-if-absent), or a calendar event we've never tapped.
        // Insert via the shared helper so the row shape can't drift across
        // the three impromptu-insert call sites.
        //
        // 23505 recovery — two distinct races:
        //   • clientMeetingId set: our scoped find returned nothing yet the PK
        //     exists. Either (a) the caller's OWN pre-create raced in after our
        //     find → re-find scoped to (id, userId) and attach audio; or (b) the
        //     id belongs to ANOTHER user → reject benignly (409), never attach
        //     to or reveal a foreign row.
        //   • calEventId set: a concurrent /from-calendar-event (or upload) for
        //     the same (user, calEventId) inserted first → re-find + update.
        try {
          await insertImpromptuMeeting(db, {
            id: meetingId,
            userId: user.sub,
            title,
            date: recordedAt,
            recordingPath: audioPath,
            // Preserve the calendar association when a calEventId was supplied
            // but no scheduled row existed yet (clientMeetingId paths are
            // impromptu → null).
            calendarEventId: clientMeetingId ? null : calendarEventId,
          })
        } catch (err) {
          if (!isUniqueViolation(err)) throw err

          if (clientMeetingId) {
            const owned = await db.query.meetings.findFirst({
              where: and(
                eq(schema.meetings.id, clientMeetingId),
                eq(schema.meetings.userId, user.sub),
              ),
              columns: { id: true },
            })
            if (!owned) {
              // Foreign id — someone else owns this PK. Don't attach audio.
              throw new GatewayError({
                statusCode: 409,
                code: 'MEETING_ID_CONFLICT',
                message: 'meetingId is not available.',
              })
            }
            await db
              .update(schema.meetings)
              .set({
                recordingPath: audioPath,
                status: 'recording',
                updatedAt: new Date(),
                updatedByUserId: user.sub,
              })
              .where(and(eq(schema.meetings.id, owned.id), eq(schema.meetings.userId, user.sub)))
            req.log.info(
              { meetingId: owned.id, userId: user.sub, metric: 'recordings.upload.precreate_raced' },
              'recordings.upload attached to caller pre-created row after 23505',
            )
            meetingId = owned.id
          } else if (calendarEventId) {
            const raced = await db.query.meetings.findFirst({
              where: and(
                eq(schema.meetings.userId, user.sub),
                eq(schema.meetings.calendarEventId, calendarEventId),
              ),
              columns: { id: true },
            })
            if (!raced) throw err
            await db
              .update(schema.meetings)
              .set({
                recordingPath: audioPath,
                status: 'recording',
                updatedAt: new Date(),
                updatedByUserId: user.sub,
              })
              .where(eq(schema.meetings.id, raced.id))
            req.log.info(
              {
                meetingId: raced.id,
                calendarEventId,
                userId: user.sub,
                metric: 'recordings.upload.collision_recovered',
              },
              'recordings.upload 23505 recovered via re-find',
            )
            meetingId = raced.id
          } else {
            throw err
          }
        }
      }

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
  // GET /recordings/_debug/last-deepgram-errors  (secret-authed)
  //
  // Returns the in-memory ring buffer of the last few Deepgram submit-400
  // events with the audio container header bytes. Gated by the same shared
  // webhook secret. Read-only; safe to leave deployed.
  // ───────────────────────────────────────────────────────────────────────────
  fastifyTyped.route({
    method: 'GET',
    url: '/recordings/_debug/last-deepgram-errors',
    schema: {
      querystring: z.object({ secret: z.string().min(1) }),
    },
    handler: async (req, reply) => {
      const { secret } = req.query
      const expected = env.DEEPGRAM_WEBHOOK_SECRET
      const provided = Buffer.from(secret)
      const reference = Buffer.from(expected)
      if (
        provided.length !== reference.length ||
        !timingSafeEqual(provided, reference)
      ) {
        return reply.code(401).send({ error: { code: 'INVALID_SECRET' } })
      }
      return reply.code(200).send({ errors: getRecentDeepgramErrors() })
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
