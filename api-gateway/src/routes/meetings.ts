import type { FastifyInstance, FastifyRequest } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { and, asc, eq, gt, sql } from 'drizzle-orm'
import { createId } from '@paralleldrive/cuid2'
import { schema } from '@cyggie/db'
import { getDb } from '../db'
import { GatewayError } from '../plugins/error'
import type { GatewayEnv } from '../env'
import { validateClientLamport } from '../sync/validate-lamport'

// =============================================================================
// /meetings — M2 read surface. Only detail today (list lives on Calendar
// for upcoming events; recorded meetings are reached via cross-links from
// Company / Contact detail). Writes (status update, edit notes) ship in M4
// once mobile sync gets the writeWithSync hook.
//
// transcript_segments is jsonb on Postgres but historically Deepgram's raw
// word-level output — we strip `words[]` and `isFinal` before returning so
// the mobile payload stays under a few hundred KB even for hour-long calls.
// =============================================================================

const TranscriptSegmentSchema = z.object({
  speaker: z.number(),
  speakerLabel: z.string().nullable(),
  text: z.string(),
  startTime: z.number(),
  endTime: z.number(),
})

const LinkedCompanySchema = z.object({
  id: z.string(),
  name: z.string(),
})

const LinkedContactSchema = z.object({
  id: z.string(),
  fullName: z.string(),
  title: z.string().nullable(),
  speakerIndex: z.number(),
})

const MeetingDetailSchema = z.object({
  id: z.string(),
  title: z.string(),
  date: z.string(),
  durationSeconds: z.number().nullable(),
  status: z.string(),
  // ISO timestamp of last server-side mutation. Mobile uses this to decide
  // whether a status='error' meeting is recent enough to be retryable —
  // see use-transcribing-poll.ts (30min age filter).
  updatedAt: z.string(),
  // Monotonic lamport clock for this row. Mobile reads this when starting
  // to edit notes; subsequent PATCH carries the value back (incremented
  // client-side) for Last-Write-Wins compare on the server. Stored as a
  // string because Postgres bigint values can exceed JS safe-integer range.
  lamport: z.string(),
  // Scheduled end time from the calendar event (migration 0015). Set on
  // /from-calendar-event creation; null for impromptu rows. Detail screen
  // uses (scheduledEndAt - date) to render "X min scheduled" pre-recording.
  scheduledEndAt: z.string().nullable(),
  wasImpromptu: z.boolean(),
  // Group-event ingestion gate (migration 098). When true, the desktop did not
  // seed contacts/companies from this meeting's attendee list. Mobile shows a
  // read-only banner; toggling lives on desktop until Phase 1.5 bidirectional
  // sync ships.
  isGroupEvent: z.boolean(),
  meetingPlatform: z.string().nullable(),
  meetingUrl: z.string().nullable(),
  notes: z.string().nullable(),
  attendees: z.array(z.string()).nullable(),
  attendeeEmails: z.array(z.string()).nullable(),
  speakerCount: z.number(),
  hasTranscript: z.boolean(),
  transcriptSegments: z.array(TranscriptSegmentSchema),
  linkedCompanies: z.array(LinkedCompanySchema),
  linkedContacts: z.array(LinkedContactSchema),
})

// Shape we trust to be present in the jsonb column. Lax — anything malformed
// or missing fields gets filtered out rather than crashing the request.
interface RawSegment {
  speaker?: unknown
  text?: unknown
  startTime?: unknown
  endTime?: unknown
  isFinal?: unknown
  words?: unknown
}

function normalizeSegments(
  raw: unknown,
  speakerMap: Record<string, unknown> | null,
): { hasTranscript: boolean; segments: Array<z.infer<typeof TranscriptSegmentSchema>> } {
  if (!Array.isArray(raw)) return { hasTranscript: false, segments: [] }
  const labelFor = (idx: number): string | null => {
    if (!speakerMap) return null
    const v = speakerMap[String(idx)]
    return typeof v === 'string' ? v : null
  }
  const out: Array<z.infer<typeof TranscriptSegmentSchema>> = []
  for (const seg of raw as RawSegment[]) {
    if (
      typeof seg.speaker !== 'number' ||
      typeof seg.text !== 'string' ||
      typeof seg.startTime !== 'number' ||
      typeof seg.endTime !== 'number'
    ) {
      continue
    }
    // Optionally collapse interim segments (isFinal === false) to keep payload
    // small — but the desktop usually writes only finals, so accept all here.
    out.push({
      speaker: seg.speaker,
      speakerLabel: labelFor(seg.speaker),
      text: seg.text,
      startTime: seg.startTime,
      endTime: seg.endTime,
    })
  }
  return { hasTranscript: out.length > 0, segments: out }
}

/**
 * Build a MeetingDetail response from a `meetings` row + its linked
 * companies/contacts. Shared by GET, POST /from-calendar-event, PATCH,
 * and the GET /sync/pull list builder so the wire shape stays single-
 * source-of-truth.
 */
async function buildMeetingDetail(
  db: ReturnType<typeof getDb>,
  meeting: typeof schema.meetings.$inferSelect,
): Promise<z.infer<typeof MeetingDetailSchema>> {
  const linkedCompanies = await db
    .select({
      id: schema.orgCompanies.id,
      name: schema.orgCompanies.canonicalName,
    })
    .from(schema.meetingCompanyLinks)
    .innerJoin(
      schema.orgCompanies,
      eq(schema.meetingCompanyLinks.companyId, schema.orgCompanies.id),
    )
    .where(eq(schema.meetingCompanyLinks.meetingId, meeting.id))

  const linkedContacts = await db
    .select({
      id: schema.contacts.id,
      fullName: schema.contacts.fullName,
      title: schema.contacts.title,
      speakerIndex: schema.meetingSpeakerContactLinks.speakerIndex,
    })
    .from(schema.meetingSpeakerContactLinks)
    .innerJoin(
      schema.contacts,
      eq(schema.meetingSpeakerContactLinks.contactId, schema.contacts.id),
    )
    .where(eq(schema.meetingSpeakerContactLinks.meetingId, meeting.id))
    .orderBy(asc(schema.meetingSpeakerContactLinks.speakerIndex))

  const speakerMap =
    (meeting.speakerMap as Record<string, unknown> | null) ?? null
  const { hasTranscript, segments } = normalizeSegments(
    meeting.transcriptSegments,
    speakerMap,
  )

  return {
    id: meeting.id,
    title: meeting.title,
    date: new Date(meeting.date).toISOString(),
    durationSeconds: meeting.durationSeconds,
    status: meeting.status,
    updatedAt: new Date(meeting.updatedAt).toISOString(),
    lamport: meeting.lamport,
    scheduledEndAt: meeting.scheduledEndAt ? new Date(meeting.scheduledEndAt).toISOString() : null,
    wasImpromptu: meeting.wasImpromptu,
    isGroupEvent: meeting.isGroupEvent,
    meetingPlatform: meeting.meetingPlatform,
    meetingUrl: meeting.meetingUrl,
    notes: meeting.notes,
    attendees: (meeting.attendees as string[] | null) ?? null,
    attendeeEmails: (meeting.attendeeEmails as string[] | null) ?? null,
    speakerCount: meeting.speakerCount,
    hasTranscript,
    transcriptSegments: segments,
    linkedCompanies,
    linkedContacts,
  }
}

/**
 * Diff calendar-sourced fields between an existing meeting row and an
 * incoming /from-cal-event payload. Returns the subset of columns that
 * need refreshing + the list of changed field names for logging.
 *
 * Comparison normalization:
 *   • Dates compared as getTime() (handles Date vs ISO string mismatch).
 *   • Arrays compared as sorted JSON (order-insensitive deep equal).
 *   • Strings + null compared with `!==`.
 *
 * Returns `{ changed: [], set: {} }` when nothing differs — caller can
 * short-circuit the UPDATE.
 */
interface FromCalEventBody {
  title: string
  startTime: string
  endTime?: string | undefined
  meetingPlatform?: string | undefined
  meetingUrl?: string | undefined
  attendees?: string[] | undefined
  attendeeEmails?: string[] | undefined
}

function diffCalendarFields(
  existing: typeof schema.meetings.$inferSelect,
  body: FromCalEventBody,
): { changed: string[]; set: Partial<typeof schema.meetings.$inferInsert> } {
  const changed: string[] = []
  const set: Partial<typeof schema.meetings.$inferInsert> = {}

  if (existing.title !== body.title) {
    changed.push('title')
    set.title = body.title
  }

  const incomingDateMs = new Date(body.startTime).getTime()
  if (existing.date.getTime() !== incomingDateMs) {
    changed.push('date')
    set.date = new Date(body.startTime)
  }

  const storedEndMs = existing.scheduledEndAt?.getTime() ?? null
  const incomingEndMs = body.endTime ? new Date(body.endTime).getTime() : null
  if (storedEndMs !== incomingEndMs) {
    changed.push('scheduledEndAt')
    set.scheduledEndAt = body.endTime ? new Date(body.endTime) : null
  }

  const incomingPlatform = body.meetingPlatform ?? null
  if (existing.meetingPlatform !== incomingPlatform) {
    changed.push('meetingPlatform')
    set.meetingPlatform = incomingPlatform
  }

  const incomingUrl = body.meetingUrl ?? null
  if (existing.meetingUrl !== incomingUrl) {
    changed.push('meetingUrl')
    set.meetingUrl = incomingUrl
  }

  const sortedJSON = (xs: string[] | null | undefined): string =>
    xs && xs.length > 0 ? JSON.stringify([...xs].sort()) : 'null'
  const incomingAttendees = body.attendees ?? null
  if (
    sortedJSON(existing.attendees as string[] | null) !==
    sortedJSON(incomingAttendees)
  ) {
    changed.push('attendees')
    set.attendees = incomingAttendees
  }
  const incomingEmails = body.attendeeEmails ?? null
  if (
    sortedJSON(existing.attendeeEmails as string[] | null) !==
    sortedJSON(incomingEmails)
  ) {
    changed.push('attendeeEmails')
    set.attendeeEmails = incomingEmails
  }

  return { changed, set }
}

export async function registerMeetingRoutes(
  app: FastifyInstance,
  env: GatewayEnv,
): Promise<void> {
  const fastifyTyped = app.withTypeProvider<ZodTypeProvider>()

  // ───────────────────────────────────────────────────────────────────────
  // GET /meetings/:id — full detail incl. linked companies + people.
  // ───────────────────────────────────────────────────────────────────────
  fastifyTyped.route({
    method: 'GET',
    url: '/meetings/:id',
    schema: {
      params: z.object({ id: z.string().min(1).max(64) }),
      response: { 200: MeetingDetailSchema },
    },
    handler: async (req) => {
      const user = req.requireFirm()
      const db = getDb(env.GATEWAY_DATABASE_URL)
      const { id } = req.params

      const meeting = await db.query.meetings.findFirst({
        where: and(eq(schema.meetings.id, id), eq(schema.meetings.userId, user.sub)),
      })
      if (!meeting) {
        throw new GatewayError({
          statusCode: 404,
          code: 'MEETING_NOT_FOUND',
          message: 'Meeting not found',
        })
      }
      return buildMeetingDetail(db, meeting)
    },
  })

  // ───────────────────────────────────────────────────────────────────────
  // POST /meetings/from-calendar-event — idempotent find-or-create.
  //
  // Mobile taps a calendar event card → calls this → lands on the meeting
  // detail screen with status='scheduled' (or whatever the existing row
  // says). Mirrors desktop's prepareMeetingFromCalendarEvent contract.
  //
  // Race-safe via Postgres unique-violation recovery: after migration 0014
  // the index is (user_id, calendar_event_id) so the catch-and-refind
  // pattern handles concurrent taps from the same user.
  //
  // Side effects (audit log, contact sync, company enrichment) are
  // SKIPPED on the gateway path per plan-ceo-review 4A — desktop runs
  // them when Phase 1.5c lands.
  // ───────────────────────────────────────────────────────────────────────
  fastifyTyped.route({
    method: 'POST',
    url: '/meetings/from-calendar-event',
    schema: {
      body: z.object({
        calendarEventId: z.string().min(1).max(256),
        title: z.string().min(1).max(512),
        // T10: accept both UTC Z and timezone-offset ISO. Mobile sends UTC
        // already; this opens the surface to curl + desktop sync + scripts
        // without 400-ing on offset form.
        startTime: z.string().datetime({ offset: true }),
        // T12: optional end time. Same offset acceptance.
        endTime: z.string().datetime({ offset: true }).optional(),
        attendees: z.array(z.string()).optional(),
        attendeeEmails: z.array(z.string()).optional(),
        meetingUrl: z.string().optional(),
        meetingPlatform: z.string().optional(),
      }),
      response: { 200: MeetingDetailSchema, 201: MeetingDetailSchema },
    },
    handler: async (req, reply) => {
      const user = req.requireFirm()
      const db = getDb(env.GATEWAY_DATABASE_URL)
      const body = req.body

      // 1. Find existing row scoped to (user_id, calendar_event_id).
      const existing = await db.query.meetings.findFirst({
        where: and(
          eq(schema.meetings.userId, user.sub),
          eq(schema.meetings.calendarEventId, body.calendarEventId),
        ),
      })
      if (existing) {
        // Refresh calendar-sourced fields if any differ from the incoming
        // payload. Closes the staleness window when a user moves / renames
        // a Google Calendar event and re-taps it. Notes + lamport are NOT
        // refreshed — those come from the PATCH path.
        const refresh = diffCalendarFields(existing, body)
        if (refresh.changed.length > 0) {
          await db
            .update(schema.meetings)
            .set({ ...refresh.set, updatedAt: new Date(), updatedByUserId: user.sub })
            .where(and(eq(schema.meetings.id, existing.id), eq(schema.meetings.userId, user.sub)))
          const refreshed = await db.query.meetings.findFirst({
            where: eq(schema.meetings.id, existing.id),
          })
          req.log.info(
            {
              meetingId: existing.id,
              calendarEventId: body.calendarEventId,
              userId: user.sub,
              changedFields: refresh.changed,
              metric: 'meetings.from_cal_event.refreshed',
            },
            'meetings.from_cal_event refreshed calendar-sourced fields',
          )
          return reply.code(200).send(await buildMeetingDetail(db, refreshed!))
        }
        return reply.code(200).send(await buildMeetingDetail(db, existing))
      }

      // 2. Insert. Catch 23505 (race against concurrent insert) → re-find.
      const newId = createId()
      try {
        await db.insert(schema.meetings).values({
          id: newId,
          userId: user.sub,
          title: body.title,
          date: new Date(body.startTime),
          scheduledEndAt: body.endTime ? new Date(body.endTime) : null,
          status: 'scheduled',
          calendarEventId: body.calendarEventId,
          meetingPlatform: body.meetingPlatform ?? null,
          meetingUrl: body.meetingUrl ?? null,
          attendees: body.attendees ?? null,
          attendeeEmails: body.attendeeEmails ?? null,
          wasImpromptu: false,
          createdByUserId: user.sub,
          // lamport defaults to '0' per schema
        })
      } catch (err) {
        // pg unique-violation = 23505. Drizzle wraps Postgres errors so we
        // check the underlying `code` if present.
        const code = err instanceof Error && 'code' in err ? (err as { code?: string }).code : null
        if (code === '23505') {
          const raced = await db.query.meetings.findFirst({
            where: and(
              eq(schema.meetings.userId, user.sub),
              eq(schema.meetings.calendarEventId, body.calendarEventId),
            ),
          })
          if (raced) {
            req.log.info(
              { calendarEventId: body.calendarEventId, userId: user.sub, metric: 'meetings.from_cal_event.collision_recovered' },
              'meetings.from_cal_event 23505 recovered via re-find',
            )
            return reply.code(200).send(await buildMeetingDetail(db, raced))
          }
        }
        throw err
      }

      const created = await db.query.meetings.findFirst({
        where: eq(schema.meetings.id, newId),
      })
      if (!created) {
        // Pathological — insert succeeded but read couldn't find it.
        throw new GatewayError({
          statusCode: 500,
          code: 'INTERNAL_ERROR',
          message: 'Failed to read back created meeting',
        })
      }
      req.log.info(
        { meetingId: newId, calendarEventId: body.calendarEventId, userId: user.sub, metric: 'meetings.from_cal_event.created' },
        'meeting created from calendar event',
      )
      return reply.code(201).send(await buildMeetingDetail(db, created))
    },
  })

  // ───────────────────────────────────────────────────────────────────────
  // PATCH /meetings/:id — partial update (notes only for V1).
  //
  // Lamport semantics MATCH the existing /sync/push handler
  // (sync.ts:201-225) — Last-Write-Wins, client-sourced lamport.
  // Incoming.lamport > stored → apply. Else → 409 with current detail
  // so the mobile outbox can drop the loser entry + refetch.
  //
  // Audit log: every notes update is logged. The notes content itself
  // is NOT logged (pino redact on the request body); only size delta
  // and lamport movement.
  // ───────────────────────────────────────────────────────────────────────
  fastifyTyped.route({
    method: 'PATCH',
    url: '/meetings/:id',
    schema: {
      params: z.object({ id: z.string().min(1).max(64) }),
      body: z.object({
        notes: z.string().max(64_000).nullable(),
        lamport: z.string().min(1).max(40),
      }),
      response: { 200: MeetingDetailSchema, 409: MeetingDetailSchema },
    },
    handler: async (req, reply) => {
      const user = req.requireFirm()
      const db = getDb(env.GATEWAY_DATABASE_URL)
      const { id } = req.params
      const body = req.body

      // T8 — ceiling check on the incoming lamport. The client clock is
      // supposed to track wall time (lamport = max(local, Date.now()) + 1
      // in nextLamport on both desktop and mobile), so anything more than
      // 5 minutes in the future is either a forgery (BigInt.MAX lockout)
      // or a pathologically clock-skewed device. Reject loudly with 400
      // before any DB write.
      const lamportCheck = validateClientLamport(body.lamport)
      if (!lamportCheck.valid) {
        req.log.warn(
          {
            meetingId: id,
            userId: user.sub,
            incoming: body.lamport,
            reason: lamportCheck.reason,
            metric: 'meetings.patch.lamport_rejected',
          },
          'patch rejected: lamport out of range',
        )
        throw new GatewayError({
          statusCode: 400,
          code: 'LAMPORT_OUT_OF_RANGE',
          message:
            lamportCheck.reason === 'unparseable'
              ? 'lamport is not a valid integer'
              : 'lamport is too far in the future',
        })
      }

      const meeting = await db.query.meetings.findFirst({
        where: and(eq(schema.meetings.id, id), eq(schema.meetings.userId, user.sub)),
      })
      if (!meeting) {
        // 404 (not 403) — don't leak the existence of meetings owned by other users.
        throw new GatewayError({
          statusCode: 404,
          code: 'MEETING_NOT_FOUND',
          message: 'Meeting not found',
        })
      }

      // Lamport LWW compare. Stored as text; compare as BigInt because
      // Postgres bigint values can exceed JS safe-integer range. Matches
      // the existing /sync/push comparison logic (sync.ts:202-225).
      const incoming = lamportCheck.bigint
      const stored = BigInt(meeting.lamport ?? '0')
      if (incoming <= stored) {
        req.log.info(
          { meetingId: id, userId: user.sub, incoming: body.lamport, stored: meeting.lamport, metric: 'meetings.patch.notes.conflict_409' },
          'patch rejected: lamport not strictly greater than stored',
        )
        return reply.code(409).send(await buildMeetingDetail(db, meeting))
      }

      const fromLength = meeting.notes?.length ?? 0
      const toLength = body.notes?.length ?? 0

      await db
        .update(schema.meetings)
        .set({
          notes: body.notes,
          lamport: body.lamport,
          updatedAt: new Date(),
          updatedByUserId: user.sub,
        })
        .where(eq(schema.meetings.id, id))

      // Audit log: track lamport movement + size delta, NOT content.
      await db.insert(schema.auditLog).values({
        userId: user.sub,
        eventType: 'meeting.notes.update',
        actor: 'user',
        targetKind: 'meeting',
        targetId: id,
        details: {
          fromLength,
          toLength,
          lamportFrom: meeting.lamport,
          lamportTo: body.lamport,
        },
      })

      req.log.info(
        { meetingId: id, userId: user.sub, fromLength, toLength, metric: 'meetings.patch.notes.success', bytesIn: toLength },
        'notes updated',
      )

      const updated = await db.query.meetings.findFirst({
        where: eq(schema.meetings.id, id),
      })
      return reply.code(200).send(await buildMeetingDetail(db, updated!))
    },
  })

  // ───────────────────────────────────────────────────────────────────────
  // DELETE /meetings/:id — user-scoped hard delete.
  //
  // Used by the empty-transcript "Discard" action so the user can clean up
  // silent / sub-threshold recordings without leaving an empty meeting row
  // cluttering the calendar list. Dependent rows
  // (meeting_company_links, meeting_speaker_contact_links) are removed via
  // ON DELETE CASCADE on the schema-level FKs. notes.source_meeting_id and
  // tasks.meeting_id are nulled (ON DELETE SET NULL).
  // ───────────────────────────────────────────────────────────────────────
  fastifyTyped.route({
    method: 'DELETE',
    url: '/meetings/:id',
    schema: {
      params: z.object({ id: z.string().min(1).max(64) }),
      response: { 200: z.object({ ok: z.literal(true) }) },
    },
    handler: async (req) => {
      const user = req.requireFirm()
      const db = getDb(env.GATEWAY_DATABASE_URL)
      const { id } = req.params

      const existing = await db.query.meetings.findFirst({
        where: and(eq(schema.meetings.id, id), eq(schema.meetings.userId, user.sub)),
        columns: { id: true },
      })
      if (!existing) {
        throw new GatewayError({
          statusCode: 404,
          code: 'MEETING_NOT_FOUND',
          message: 'Meeting not found',
        })
      }

      await db.delete(schema.meetings).where(eq(schema.meetings.id, id))
      return { ok: true as const }
    },
  })
}
