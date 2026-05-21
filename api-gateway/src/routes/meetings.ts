import type { FastifyInstance } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { and, asc, eq } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import { getDb } from '../db'
import { GatewayError } from '../plugins/error'
import type { GatewayEnv } from '../env'

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

      // Linked companies (via meeting_company_links).
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
        .where(eq(schema.meetingCompanyLinks.meetingId, id))

      // Linked contacts (via meeting_speaker_contact_links).
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
        .where(eq(schema.meetingSpeakerContactLinks.meetingId, id))
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
