import type { FastifyInstance, FastifyRequest } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm'
import { createId } from '@paralleldrive/cuid2'
import { schema } from '@cyggie/db'
import { getDb } from '../db'
import { GatewayError } from '../plugins/error'
import type { GatewayEnv } from '../env'
import { validateClientLamport } from '../sync/validate-lamport'
import Anthropic from '@anthropic-ai/sdk'
import { resolveAnthropicKey, toGatewayErrorIfAnthropic } from '../llm/resolve-key'
import {
  flattenSegments,
  hasTranscriptContent,
  truncateTranscript,
} from '../llm/transcript-flatten'
import {
  TEMPLATE_IDS,
  findTemplate,
  substitutePlaceholders,
} from '../templates/meeting-summary-templates'

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

// Per-attendee resolution: the calendar event lists invitees as flat
// strings; we resolve each invitee's email against the user's contacts
// table so mobile can render clickable chips that route to the contact
// view. Independent of `linkedContacts`, which is populated post-
// transcription via speaker→contact tagging.
const AttendeeContactSchema = z.object({
  name: z.string(),
  email: z.string().nullable(),
  contactId: z.string().nullable(),
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
  // T5 — surfaced for the "Record" CTA on scheduled meetings. Mobile
  // passes it into /record so the upload's find-or-update branch lights
  // up this row instead of inserting an impromptu one. Null on rows
  // created from the Record FAB (no originating calendar event).
  calendarEventId: z.string().nullable(),
  wasImpromptu: z.boolean(),
  // Group-event ingestion gate (migration 098). When true, the desktop did not
  // seed contacts/companies from this meeting's attendee list. Mobile shows a
  // read-only banner; toggling lives on desktop until Phase 1.5 bidirectional
  // sync ships.
  isGroupEvent: z.boolean(),
  meetingPlatform: z.string().nullable(),
  meetingUrl: z.string().nullable(),
  notes: z.string().nullable(),
  // AI-generated meeting summary markdown. Item 2 — dual-written by the
  // desktop summarizer alongside `summaryPath` so mobile can render it
  // without needing local-disk access. Null when the meeting hasn't been
  // summarized yet (or predates the dual-write).
  summary: z.string().nullable(),
  attendees: z.array(z.string()).nullable(),
  attendeeEmails: z.array(z.string()).nullable(),
  speakerCount: z.number(),
  hasTranscript: z.boolean(),
  transcriptSegments: z.array(TranscriptSegmentSchema),
  linkedCompanies: z.array(LinkedCompanySchema),
  linkedContacts: z.array(LinkedContactSchema),
  attendeeContacts: z.array(AttendeeContactSchema),
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

  // Resolve each calendar attendee email to a contact id, mirroring
  // the desktop's two-table lookup at
  // packages/db/src/sqlite/repositories/contact.repo.ts:429-439:
  //
  //   email matches  →  contacts.email  (primary)
  //                  →  contact_emails.email  (aliases)
  //
  // Always scoped by contacts.user_id so cross-tenant data can't leak
  // even if two firms have a contact with the same email. Unmatched
  // attendees (or those with no email at all) get a contactId of null
  // and render as non-clickable chips on mobile.
  const attendeeNames = (meeting.attendees as string[] | null) ?? []
  const attendeeEmails = (meeting.attendeeEmails as string[] | null) ?? []
  const lowercasedEmails = Array.from(
    new Set(
      attendeeEmails
        .filter((e): e is string => typeof e === 'string' && e.length > 0)
        .map((e) => e.toLowerCase()),
    ),
  )
  const emailToContactId = new Map<string, string>()
  if (lowercasedEmails.length > 0) {
    // Primary email column on contacts.
    const primaryMatches = await db
      .select({
        id: schema.contacts.id,
        email: sql<string>`lower(${schema.contacts.email})`,
      })
      .from(schema.contacts)
      .where(
        and(
          eq(schema.contacts.userId, meeting.userId),
          inArray(sql`lower(${schema.contacts.email})`, lowercasedEmails),
        ),
      )
    for (const row of primaryMatches) {
      if (row.email) emailToContactId.set(row.email, row.id)
    }

    // Alias emails on contact_emails. Inner-join with contacts to scope by user_id.
    const aliasMatches = await db
      .select({
        id: schema.contactEmails.contactId,
        email: sql<string>`lower(${schema.contactEmails.email})`,
      })
      .from(schema.contactEmails)
      .innerJoin(schema.contacts, eq(schema.contactEmails.contactId, schema.contacts.id))
      .where(
        and(
          eq(schema.contacts.userId, meeting.userId),
          inArray(sql`lower(${schema.contactEmails.email})`, lowercasedEmails),
        ),
      )
    for (const row of aliasMatches) {
      if (row.email && !emailToContactId.has(row.email)) {
        emailToContactId.set(row.email, row.id)
      }
    }
  }
  const attendeeContacts = attendeeNames.map((name, idx) => {
    const rawEmail = attendeeEmails[idx]
    const email =
      typeof rawEmail === 'string' && rawEmail.length > 0 ? rawEmail : null
    const contactId = email
      ? emailToContactId.get(email.toLowerCase()) ?? null
      : null
    return { name, email, contactId }
  })

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
    calendarEventId: meeting.calendarEventId,
    wasImpromptu: meeting.wasImpromptu,
    isGroupEvent: meeting.isGroupEvent,
    meetingPlatform: meeting.meetingPlatform,
    meetingUrl: meeting.meetingUrl,
    notes: meeting.notes,
    summary: meeting.summary ?? null,
    attendees: (meeting.attendees as string[] | null) ?? null,
    attendeeEmails: (meeting.attendeeEmails as string[] | null) ?? null,
    speakerCount: meeting.speakerCount,
    hasTranscript,
    transcriptSegments: segments,
    linkedCompanies,
    linkedContacts,
    attendeeContacts,
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
  // ───────────────────────────────────────────────────────────────────────
  // POST /meetings/:id/enhance — desktop-parity Enhance for mobile.
  //
  // Reads the meeting's transcript + notes, runs them through Claude with
  // a user-picked template (vc_pitch | founder_checkin | partners | lp |
  // general), and writes the resulting markdown back to meetings.summary.
  // Also bumps lamport + transitions status to 'summarized'. Mirrors
  // desktop's generateSummary() service so a meeting summarized from
  // mobile and one summarized from desktop look identical.
  //
  // Server-side write (Claude → gateway → Neon). Concurrent with the
  // desktop summarizer's dual-write path: lamport LWW resolves the race
  // (Issue 1B accepted for single-firm beta).
  //
  // 30s server-side timeout via AbortSignal so a hung Anthropic call
  // can't hold the request open indefinitely (Issue 2 gap fix).
  // ───────────────────────────────────────────────────────────────────────
  fastifyTyped.route({
    method: 'POST',
    url: '/meetings/:id/enhance',
    schema: {
      params: z.object({ id: z.string().min(1).max(64) }),
      body: z.object({
        templateId: z.enum(TEMPLATE_IDS as unknown as [string, ...string[]]),
      }),
      response: {
        200: z.object({
          summary: z.string(),
          lamport: z.string(),
          status: z.string(),
        }),
      },
    },
    handler: async (req) => {
      const user = req.requireFirm()
      const db = getDb(env.GATEWAY_DATABASE_URL)
      const { id } = req.params
      const { templateId } = req.body
      const startedAtMs = Date.now()

      req.log.info(
        { metric: 'meetings.enhance.start', meetingId: id, templateId, userId: user.sub },
        'enhance start',
      )

      // Load meeting + verify ownership. DB error wrap (Issue 2 gap fix).
      // Ordering note: ownership check FIRST (before key resolution) so a
      // request for someone else's meeting returns 404, not 503. Key
      // resolution happens last, just before the Anthropic call.
      let meeting: typeof schema.meetings.$inferSelect | undefined
      try {
        meeting = await db.query.meetings.findFirst({
          where: and(eq(schema.meetings.id, id), eq(schema.meetings.userId, user.sub)),
        })
      } catch (err) {
        req.log.error({ err, meetingId: id, userId: user.sub }, 'enhance: meeting fetch failed')
        throw new GatewayError({
          statusCode: 500,
          code: 'INTERNAL_ERROR',
          message: 'Failed to load meeting',
        })
      }
      if (!meeting) {
        throw new GatewayError({
          statusCode: 404,
          code: 'MEETING_NOT_FOUND',
          message: 'Meeting not found',
        })
      }

      // Issue 1A — strict transcript gate. Null, empty array, or all
      // empty-text segments all reject the same way.
      if (!hasTranscriptContent(meeting.transcriptSegments)) {
        req.log.info(
          { metric: 'meetings.enhance.rejected_no_transcript', meetingId: id, userId: user.sub },
          'enhance rejected: no transcript',
        )
        throw new GatewayError({
          statusCode: 400,
          code: 'NO_TRANSCRIPT',
          message: 'No transcript available to summarize.',
        })
      }

      const template = findTemplate(templateId)
      if (!template) {
        // Zod enum should have blocked this, but defense in depth.
        req.log.warn(
          { metric: 'meetings.enhance.rejected_invalid_template', templateId, userId: user.sub },
          'enhance rejected: invalid template',
        )
        throw new GatewayError({
          statusCode: 400,
          code: 'INVALID_TEMPLATE',
          message: 'Unknown templateId',
        })
      }

      // Build prompt context. Speakers come from speakerMap when present;
      // fall back to "Unknown participants" so the template variable
      // doesn't render literally.
      const speakerMap = (meeting.speakerMap as Record<string, string> | null) ?? null
      const speakerNames = speakerMap ? Object.values(speakerMap) : []
      const speakers = speakerNames.length > 0 ? speakerNames.join(', ') : 'Unknown participants'

      const durationMin = meeting.durationSeconds
        ? `${Math.round(meeting.durationSeconds / 60)} minutes`
        : 'Unknown'

      const transcriptFlat = truncateTranscript(
        flattenSegments(meeting.transcriptSegments),
      )

      const userPrompt = substitutePlaceholders(template, {
        meetingTitle: meeting.title ?? '(untitled)',
        date: new Date(meeting.date).toLocaleDateString(),
        duration: durationMin,
        speakers,
        transcript: transcriptFlat,
        notes: meeting.notes ?? '',
      })

      // Resolve key just before the Anthropic call — keeps the
      // earlier gates (ownership, transcript shape, template id) free
      // to return their proper status codes for users with no key set.
      const apiKey = await resolveAnthropicKey(env, user.sub)
      if (!apiKey) {
        req.log.warn(
          { metric: 'meetings.enhance.rejected_no_key', meetingId: id, userId: user.sub },
          'enhance rejected: no anthropic key',
        )
        throw new GatewayError({
          statusCode: 503,
          code: 'CHAT_UNAVAILABLE',
          message:
            'No Anthropic API key configured. Set one in desktop Settings → AI & Transcription.',
        })
      }

      // 60s timeout — bounds the worst-case for a hung Anthropic call.
      // First version was 30s; bumped after a 54-min transcript on the
      // founder_checkin template hit 30.2s and got cleanly aborted with
      // a working summary 90% drafted. 60s gives Claude room for long
      // transcripts without keeping the request open indefinitely.
      // Mobile pads to 75s so the gateway timeout always fires first
      // and surfaces a clean CHAT_TIMEOUT instead of a bare AbortError.
      const abortController = new AbortController()
      const timeoutHandle = setTimeout(() => abortController.abort(), 60_000)

      const client = new Anthropic({ apiKey })
      let result
      try {
        result = await client.messages.create(
          {
            model: 'claude-sonnet-4-5-20250929',
            max_tokens: 4096,
            system: template.systemPrompt,
            messages: [{ role: 'user', content: userPrompt }],
          },
          { signal: abortController.signal },
        )
      } catch (err) {
        clearTimeout(timeoutHandle)
        const gw = toGatewayErrorIfAnthropic(err)
        if (gw) {
          req.log.warn(
            {
              metric: 'meetings.enhance.error',
              meetingId: id,
              userId: user.sub,
              duration_ms: Date.now() - startedAtMs,
              upstreamStatus: gw.details && typeof gw.details === 'object' && 'upstreamStatus' in gw.details
                ? (gw.details as { upstreamStatus: number }).upstreamStatus
                : null,
              errCode: gw.code,
            },
            'enhance: upstream anthropic error',
          )
          throw gw
        }
        req.log.error({ err, meetingId: id, userId: user.sub }, 'enhance: unhandled error')
        throw err
      }
      clearTimeout(timeoutHandle)

      const summaryText = result.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim()

      if (!summaryText) {
        throw new GatewayError({
          statusCode: 502,
          code: 'CHAT_EMPTY',
          message: 'Claude returned no text content.',
        })
      }

      // Server-mint lamport: BigInt math to stay safe at large values,
      // matches client-side max-of-local-or-wallclock pattern (validate-lamport.ts:12).
      const storedLamport = BigInt(meeting.lamport ?? '0')
      const wallLamport = BigInt(Date.now())
      const nextLamport = ((storedLamport > wallLamport ? storedLamport : wallLamport) + 1n).toString()

      try {
        await db
          .update(schema.meetings)
          .set({
            summary: summaryText,
            status: 'summarized',
            lamport: nextLamport,
            updatedAt: new Date(),
          })
          .where(and(eq(schema.meetings.id, id), eq(schema.meetings.userId, user.sub)))
      } catch (err) {
        req.log.error({ err, meetingId: id, userId: user.sub }, 'enhance: meeting update failed')
        throw new GatewayError({
          statusCode: 500,
          code: 'INTERNAL_ERROR',
          message: 'Failed to persist summary',
        })
      }

      req.log.info(
        {
          metric: 'meetings.enhance.complete',
          meetingId: id,
          templateId,
          userId: user.sub,
          duration_ms: Date.now() - startedAtMs,
          inputTokens: result.usage?.input_tokens ?? null,
          outputTokens: result.usage?.output_tokens ?? null,
          model: result.model,
          summaryLength: summaryText.length,
        },
        'enhance complete',
      )

      return {
        summary: summaryText,
        lamport: nextLamport,
        status: 'summarized',
      }
    },
  })

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
